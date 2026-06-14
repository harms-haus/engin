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
  // Task titles keyed by taskId. Populated from onTasksAdded/onTaskStart so the
  // title can be applied to the agent record in onAgentSpawn, regardless of
  // callback ordering (in production onTaskStart fires BEFORE onAgentSpawn).
  const taskTitles = new Map<string, string>();

  // ─── Seed initial agents from persisted state ───────────────────────────

  if (initialAgents) {
    for (const agent of initialAgents) {
      const uid = dashboard.registry.register({
        agentId: agent.agentId,
        profile: agent.profile,
        phase: agent.phase,
        taskId: agent.taskId,
      });
      if (agent.completedAt) {
        dashboard.registry.complete(uid);
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
        // The lane pool is cleared per phase so the new pool starts fresh.
        // The AgentRegistry is NOT cleared because agents accumulate across all phases.
        // This is intentional: the agent log shows agents from all phases.
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
    ttls: Map<string, string>,
    render: () => void,
  ): Pick<
    StatusCallbacks,
    'onAgentSpawn' | 'onAgentComplete' | 'onDecision' | 'onError' | 'onTurnEnd' | 'onToolCallStart' | 'onToolCallEnd'
  > {
    return {
      onAgentSpawn(info) {
        evLog.addLine('⏳ Agent ' + info.agentId + ' spawned (' + info.profile + ')');

        // Register the agent in the registry, which assigns a unique UID.
        const uid = dash.registry.register({
          agentId: info.agentId,
          profile: info.profile,
          phase: info.phase,
          taskId: info.taskId,
          sessionId: info.sessionId,
          sessionPath: info.sessionPath,
        });
        if (info.taskId) {
          t2a.set(info.taskId, info.agentId);
          // In production onTaskStart fires before onAgentSpawn, so the title
          // cannot be applied there (the agent record does not exist yet).
          // Instead we stash the title in `ttls` and apply it here once the
          // record exists.
          const title = ttls.get(info.taskId);
          if (title) {
            dash.registry.updateStats(uid, { taskTitle: title });
          }
        }
        dash.agentLog.invalidate();
        render();
      },

      onAgentComplete(info) {
        evLog.addLine('✅ Agent ' + info.agentId + ' complete');
        const uid = dash.registry.getActiveUid(info.agentId);
        if (uid) {
          dash.registry.addEntry(uid, { type: 'text', content: 'Agent session ended' });
          dash.registry.complete(uid);
        }
        dash.agentLog.invalidate();
        render();
      },

      onDecision(_info) {
        render();
      },

      onError(info) {
        const safeError = stripAnsi(info.error);
        evLog.addLine('⚠️ Error in ' + info.agentId + ': ' + safeError + ' (' + info.phase + ')');
        const uid = dash.registry.getActiveUid(info.agentId);
        if (uid) {
          dash.registry.addEntry(uid, { type: 'error', content: safeError });
        }
        dash.agentLog.invalidate();
        render();
      },

      onTurnEnd(info) {
        const uid = dash.registry.getActiveUid(info.agentId);
        if (!uid) return;

        if (info.contentBlocks) {
          for (const block of info.contentBlocks) {
            if (block.type === 'text' && block.text.length > 0) {
              const safeText = stripAnsi(block.text);
              dash.registry.addEntry(uid, { type: 'text', content: safeText });
            } else if (block.type === 'thinking') {
              dash.registry.addEntry(uid, { type: 'thinking', content: stripAnsi(block.thinking) });
            }
          }
        }
        if (info.tokens) {
          dash.registry.updateStats(uid, {
            inputTokens: info.tokens.input,
            outputTokens: info.tokens.output,
          });
        }
        dash.agentLog.invalidate();
        render();
      },

      onToolCallStart(info) {
        const uid = dash.registry.getActiveUid(info.agentId);
        if (uid) {
          dash.registry.addEntry(uid, {
            type: 'tool_call_start',
            content: formatToolCall(info.toolName, info.arguments ?? {}),
          });
          dash.registry.updateStats(uid, { toolCallCount: 1 });
        }
        dash.agentLog.invalidate();
        render();
      },

      onToolCallEnd(info) {
        if (info.isError) {
          const uid = dash.registry.getActiveUid(info.agentId);
          if (uid) {
            dash.registry.addEntry(uid, { type: 'error', content: `❌ ${info.toolName} failed` });
          }
        }
        dash.agentLog.invalidate();
        render();
      },
    };
  }

  function buildTaskHandlers(
    evLog: EventLog,
    dash: Dashboard,
    lns: Map<string, TaskLane>,
    t2a: Map<string, string>,
    ttls: Map<string, string>,
    render: () => void,
  ): Pick<StatusCallbacks, 'onTasksAdded' | 'onTaskStart' | 'onTaskStepStart' | 'onTaskComplete' | 'onTaskRejected'> {
    return {
      onTasksAdded(info) {
        for (const task of info.tasks) {
          const safeTitle = stripAnsi(task.title);
          ttls.set(task.id, safeTitle);
          lns.set(task.id, {
            id: task.id,
            title: safeTitle,
            status: task.status,
            phase: task.phase,
          });
        }
        dash.lanePool.updateLanes(Array.from(lns.values()));
        render();
      },

      onTaskStart(info) {
        const safeTitle = stripAnsi(info.title);
        ttls.set(info.taskId, safeTitle);
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
        const uid = dash.registry.getActiveUid(agentId);
        if (uid) {
          dash.registry.updateStats(uid, { taskTitle: safeTitle });
        }
        render();
      },

      onTaskStepStart(info) {
        const lane = lns.get(info.taskId);
        if (lane && lane.stepInfo !== info.stepName) {
          lane.stepInfo = info.stepName;
          dash.lanePool.updateLanes(Array.from(lns.values()));
        }
        render();
      },

      onTaskComplete(info) {
        evLog.addLine('✅ Task ' + info.taskId + ' complete');
        const lane = lns.get(info.taskId);
        if (lane) {
          lane.status = 'done';
          lane.completedAt = Date.now();
          dash.lanePool.updateLanes(Array.from(lns.values()));
        }
        render();
      },

      onTaskRejected(info) {
        evLog.addLine('❌ Task ' + info.taskId + ' rejected: ' + info.reason);
        const lane = lns.get(info.taskId);
        if (lane) {
          lane.status = 'failed';
          lane.completedAt = Date.now();
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
    ...buildAgentHandlers(eventLog, dashboard, taskToAgent, taskTitles, requestRender),
    ...buildTaskHandlers(eventLog, dashboard, lanes, taskToAgent, taskTitles, requestRender),

    onSidebarUpdate(info) {
      if (info.phases) {
        dashboard.phaseBar.setPhases(info.phases);
        dashboard.agentLog.setPhases(info.phases.map((p) => p.id));
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
