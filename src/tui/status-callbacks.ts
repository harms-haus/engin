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
  initialAgents?: {
    agentId: string;
    profile: string;
    phase: string;
    taskId?: string;
    completedAt?: string;
  }[];
}): StatusCallbacks {
  const { eventLog, dashboard, requestRender, initialAgents } = deps;

  const lanes = new Map<string, TaskLane>();
  // Lanes accumulate for the lifetime of the workflow; completed lanes remain visible.
  const completedPhases: string[] = [];
  // Reverse map for task → agent lookups
  const taskToAgent = new Map<string, string>();

  // ─── Seed initial agents from persisted state ───────────────────────────

  if (initialAgents) {
    for (const agent of initialAgents) {
      dashboard.agentLog.selectAgentInPhase(agent.agentId, agent.phase, agent.profile);
      dashboard.agentLog.updateStats(agent.agentId, { profile: agent.profile });
      if (agent.completedAt) {
        dashboard.agentLog.markAgentComplete(agent.agentId);
      }
    }
  }

  // ─── Builder helpers ─────────────────────────────────────────────────────

  function buildWorkflowHandlers(
    evLog: EventLog,
    render: () => void,
  ): Pick<StatusCallbacks, 'onWorkflowStart' | 'onWorkflowComplete' | 'onWorkflowFailed'> {
    return {
      onWorkflowStart(info) {
        evLog.addLine('🚀 Workflow started: "' + info.taskPrompt + '" (resumed: ' + info.resumed + ')');
        render();
      },

      onWorkflowComplete(info) {
        evLog.addLine(
          '🎉 Complete in ' + (info.totalDurationMs / 1000).toFixed(1) + 's (' + info.agentCount + ' agents)',
        );
        render();
      },

      onWorkflowFailed(info) {
        evLog.addLine('💥 Failed at ' + info.phase + ': ' + info.error.message);
        render();
      },
    };
  }

  function buildPhaseHandlers(
    evLog: EventLog,
    dash: Dashboard,
    completed: string[],
    lns: Map<string, TaskLane>,
    t2a: Map<string, string>,
    render: () => void,
  ): Pick<StatusCallbacks, 'onPhaseStart' | 'onPhaseComplete'> {
    return {
      onPhaseStart(info) {
        evLog.addLine('📦 Phase: ' + info.phase + ' (round ' + info.round + ')');
        dash.phaseBar.setCurrentPhase(info.phase);
        dash.agentLog.setCurrentPhase(info.phase);
        // Clear lanes from previous phase so the new pool starts fresh
        lns.clear();
        t2a.clear();
        dash.lanePool.updateLanes([]);
        render();
      },

      onPhaseComplete(info) {
        evLog.addLine('✅ Phase ' + info.phase + ' done (' + (info.durationMs / 1000).toFixed(1) + 's)');
        completed.push(info.phase);
        dash.phaseBar.setCompletedPhases(completed);
        render();
      },
    };
  }

  function buildAgentHandlers(
    evLog: EventLog,
    dash: Dashboard,
    t2a: Map<string, string>,
    render: () => void,
  ): Pick<
    StatusCallbacks,
    'onAgentSpawn' | 'onAgentComplete' | 'onDecision' | 'onError' | 'onTurnEnd' | 'onToolCallStart' | 'onToolCallEnd'
  > {
    return {
      onAgentSpawn(info) {
        evLog.addLine('⏳ Agent ' + info.agentId + ' spawned (' + info.profile + ')');

        // If a previous manual spawn used the taskId as the agentId (e.g. scouting
        // phase spawns "scout-topic" then LanePool spawns "lane-0" with taskId
        // "scout-topic"), merge the two entries to avoid duplicates.
        if (info.taskId && info.taskId !== info.agentId) {
          const prevAgentId = t2a.get(info.taskId) ?? info.taskId;
          if (prevAgentId !== info.agentId && dash.agentLog.hasAgent(prevAgentId)) {
            // Transfer any data from the placeholder agent to the real one
            dash.agentLog.transferAgent(prevAgentId, info.agentId);
          }
        }

        dash.agentLog.selectAgentInPhase(info.agentId, info.phase, info.profile);
        dash.agentLog.updateStats(info.agentId, { profile: info.profile });
        if (info.taskId) {
          t2a.set(info.taskId, info.agentId);
        }
        render();
      },

      onAgentComplete(info) {
        evLog.addLine('✅ Agent ' + info.agentId + ' complete');
        dash.agentLog.addEntry({ type: 'text', content: 'Agent session ended' }, info.agentId);
        dash.agentLog.markAgentComplete(info.agentId);
        render();
      },

      onDecision(_info) {
        render();
      },

      onError(info) {
        const safeError = stripAnsi(info.error);
        evLog.addLine('⚠️ Error in ' + info.agentId + ': ' + safeError + ' (' + info.phase + ')');
        dash.agentLog.addEntry({ type: 'error', content: safeError }, info.agentId);
        render();
      },

      onTurnEnd(info) {
        if (info.contentBlocks) {
          for (const block of info.contentBlocks) {
            if (block.type === 'text' && block.text.length > 0) {
              const safeText = stripAnsi(block.text);
              dash.agentLog.addEntry({ type: 'text', content: safeText }, info.agentId);
            } else if (block.type === 'thinking') {
              dash.agentLog.addEntry({ type: 'thinking', content: stripAnsi(block.thinking) }, info.agentId);
            }
          }
        }
        if (info.tokens) {
          dash.agentLog.updateStats(info.agentId, {
            inputTokens: info.tokens.input,
            outputTokens: info.tokens.output,
          });
        }
        render();
      },

      onToolCallStart(info) {
        dash.agentLog.addEntry(
          { type: 'tool_call_start', content: formatToolCall(info.toolName, info.arguments ?? {}) },
          info.agentId,
        );
        dash.agentLog.updateStats(info.agentId, { toolCallCount: 1 });
        render();
      },

      onToolCallEnd(info) {
        if (info.isError) {
          dash.agentLog.addEntry({ type: 'error', content: `❌ ${info.toolName} failed` }, info.agentId);
        }
        render();
      },
    };
  }

  function buildTaskHandlers(
    evLog: EventLog,
    dash: Dashboard,
    lns: Map<string, TaskLane>,
    t2a: Map<string, string>,
    render: () => void,
  ): Pick<StatusCallbacks, 'onTasksAdded' | 'onTaskStart' | 'onTaskComplete' | 'onTaskRejected'> {
    return {
      onTasksAdded(info) {
        for (const task of info.tasks) {
          lns.set(task.id, {
            id: task.id,
            title: stripAnsi(task.title),
            status: task.status,
            phase: task.phase,
          });
        }
        dash.lanePool.updateLanes(Array.from(lns.values()));
        render();
      },

      onTaskStart(info) {
        const safeTitle = stripAnsi(info.title);
        evLog.addLine('📋 Task ' + info.taskId + ': "' + safeTitle + '"');
        lns.set(info.taskId, {
          id: info.taskId,
          title: safeTitle,
          status: 'implementing' as TaskStatus,
          agentId: info.agentId,
          phase: info.phase,
          startedAt: info.startedAt,
        });
        dash.lanePool.updateLanes(Array.from(lns.values()));
        // Update task title on the associated agent
        const agentId = t2a.get(info.taskId) ?? info.agentId;
        dash.agentLog.updateStats(agentId, { taskTitle: safeTitle });
        render();
      },

      onTaskComplete(info) {
        evLog.addLine('✅ Task ' + info.taskId + ' complete');
        const lane = lns.get(info.taskId);
        if (lane) {
          lane.status = 'done';
          dash.lanePool.updateLanes(Array.from(lns.values()));
        }
        render();
      },

      onTaskRejected(info) {
        evLog.addLine('❌ Task ' + info.taskId + ' rejected: ' + info.reason);
        const lane = lns.get(info.taskId);
        if (lane) {
          lane.status = 'failed';
          dash.lanePool.updateLanes(Array.from(lns.values()));
        }
        render();
      },
    };
  }

  // ─── Assemble ────────────────────────────────────────────────────────────

  return {
    ...buildWorkflowHandlers(eventLog, requestRender),
    ...buildPhaseHandlers(eventLog, dashboard, completedPhases, lanes, taskToAgent, requestRender),
    ...buildAgentHandlers(eventLog, dashboard, taskToAgent, requestRender),
    ...buildTaskHandlers(eventLog, dashboard, lanes, taskToAgent, requestRender),

    onSidebarUpdate(info) {
      if (info.phases) {
        dashboard.phaseBar.setPhases(info.phases);
        dashboard.agentLog.setAvailablePhases(info.phases.map((p) => p.id));
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
