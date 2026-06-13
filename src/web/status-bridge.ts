import type { StatusCallbacks, TurnContentBlock } from '../core/types.js';
import type { AgentWindowState, LogEntry, ServerMessage, SidebarInfo, TaskInfo } from './protocol-types.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Build a composite key for agent lookup.
 */
export function agentKey(agentId: string, taskId?: string): string {
  return taskId ? agentId + '::' + taskId : agentId;
}

// ─── StatusBridge ───────────────────────────────────────────────────────────

/**
 * Lightweight StatusCallbacks implementation that broadcasts all workflow
 * events via WebSocket and maintains state for snapshot-on-connect.
 *
 * Does NOT use RunRegistry.
 */
export class StatusBridge {
  private currentPhase = '';
  private completedPhases: string[] = [];
  private tasks = new Map<string, TaskInfo>();
  private agents = new Map<string, AgentWindowState>();
  private sidebar: SidebarInfo = { title: '', indicator: '' };

  constructor(private broadcast: (msg: ServerMessage) => void) {}

  /**
   * Return a StatusCallbacks object wired to this bridge.
   */
  getCallbacks(): StatusCallbacks {
    return {
      ...this.createWorkflowHandlers(),
      ...this.createPhaseHandlers(),
      ...this.createAgentHandlers(),
      ...this.createTaskHandlers(),
      onSidebarUpdate: (info) => {
        if (info.title !== undefined) this.sidebar.title = info.title;
        if (info.indicator !== undefined) this.sidebar.indicator = info.indicator;
        if (info.phases !== undefined) this.sidebar.phases = info.phases;
        this.broadcast({ type: 'workflow_sidebar', sidebar: { ...this.sidebar } });
      },
    };
  }

  // ─── Handler-group builders ──────────────────────────────────────────────

  private createWorkflowHandlers(): Pick<
    StatusCallbacks,
    'onWorkflowStart' | 'onWorkflowComplete' | 'onWorkflowFailed'
  > {
    return {
      onWorkflowStart: () => {
        // no-op: workflow start is not broadcast
      },

      onWorkflowComplete: () => {
        this.broadcast({ type: 'workflow_complete' });
      },

      onWorkflowFailed: (info) => {
        this.broadcast({ type: 'workflow_failed', error: info.error.message, phase: info.phase });
      },
    };
  }

  private createPhaseHandlers(): Pick<StatusCallbacks, 'onPhaseStart' | 'onPhaseComplete'> {
    return {
      onPhaseStart: (info) => {
        if (this.currentPhase) {
          this.completedPhases.push(this.currentPhase);
        }
        this.currentPhase = info.phase;
        this.broadcast({
          type: 'workflow_phase',
          phase: info.phase,
          completed: [...this.completedPhases],
          currentPhase: info.phase,
        });
      },

      onPhaseComplete: (info) => {
        if (!this.completedPhases.includes(info.phase)) {
          this.completedPhases.push(info.phase);
        }
        this.broadcast({
          type: 'workflow_phase',
          phase: info.phase,
          completed: [...this.completedPhases],
          currentPhase: this.currentPhase,
        });
      },
    };
  }

  private createAgentHandlers(): Pick<
    StatusCallbacks,
    'onAgentSpawn' | 'onAgentComplete' | 'onTurnEnd' | 'onToolCallStart' | 'onToolCallEnd' | 'onError' | 'onDecision'
  > {
    return {
      onAgentSpawn: (info) => {
        const agent: AgentWindowState = {
          agentId: info.agentId,
          profile: info.profile,
          taskId: info.taskId,
          phase: info.phase,
          active: true,
          log: [],
        };
        this.agents.set(agentKey(info.agentId, info.taskId), agent);
        this.broadcast({ type: 'agent_spawned', agent });
      },

      onAgentComplete: (info) => {
        const key = agentKey(info.agentId, info.taskId);
        const agent = this.agents.get(key) || this.agents.get(info.agentId);
        if (agent) {
          agent.active = false;
        }
        this.broadcast({
          type: 'agent_complete',
          agentId: info.agentId,
          phase: info.phase,
          taskId: info.taskId,
        });
      },

      onTurnEnd: (info) => {
        const taskId = this.findTaskIdForAgent(info.agentId);
        if (info.contentBlocks) {
          for (const block of info.contentBlocks) {
            const entry = this.blockToEntry(block);
            if (entry) {
              this.appendAgentLog(info.agentId, taskId, entry);
              this.broadcast({
                type: 'agent_log',
                agentId: info.agentId,
                entry,
                ...(taskId !== undefined ? { taskId } : {}),
              });
            }
          }
        }
        if (info.tokens) {
          this.broadcast({
            type: 'agent_stats',
            agentId: info.agentId,
            inputTokens: info.tokens.input,
            outputTokens: info.tokens.output,
            ...(taskId !== undefined ? { taskId } : {}),
          });
        }
      },

      onToolCallStart: (info) => {
        const taskId = this.findTaskIdForAgent(info.agentId);
        const entry: LogEntry = {
          id: info.toolCallId,
          timestamp: new Date().toISOString(),
          type: 'tool_call_start',
          content: info.toolName,
        };
        this.appendAgentLog(info.agentId, taskId, entry);
        this.broadcast({
          type: 'agent_log',
          agentId: info.agentId,
          entry,
          ...(taskId !== undefined ? { taskId } : {}),
        });
        this.broadcast({
          type: 'agent_stats',
          agentId: info.agentId,
          toolCallCount: 1,
          ...(taskId !== undefined ? { taskId } : {}),
        });
      },

      onToolCallEnd: (info) => {
        const taskId = this.findTaskIdForAgent(info.agentId);
        const entry: LogEntry = {
          id: info.toolCallId + '-end',
          timestamp: new Date().toISOString(),
          type: 'tool_call_end' as const,
          content: info.toolName,
          metadata: { isError: info.isError },
        };
        this.appendAgentLog(info.agentId, taskId, entry);
        this.broadcast({
          type: 'agent_log',
          agentId: info.agentId,
          entry,
          ...(taskId !== undefined ? { taskId } : {}),
        });
      },

      onError: (info) => {
        const entry: LogEntry = {
          id: `error-${Date.now()}`,
          timestamp: new Date().toISOString(),
          type: 'error',
          content: info.error,
          metadata: { phase: info.phase },
        };
        this.appendAgentLog(info.agentId, info.taskId, entry);
        this.broadcast({ type: 'agent_log', agentId: info.agentId, entry, taskId: info.taskId });
      },

      onDecision: (info) => {
        const entry: LogEntry = {
          id: `decision-${Date.now()}`,
          timestamp: new Date().toISOString(),
          type: 'decision',
          content: info.decision,
          metadata: { reasoning: info.reasoning },
        };
        this.appendAgentLog(info.agentId, info.taskId, entry);
        this.broadcast({ type: 'agent_log', agentId: info.agentId, entry, taskId: info.taskId });
      },
    };
  }

  private createTaskHandlers(): Pick<
    StatusCallbacks,
    'onTasksAdded' | 'onTaskStart' | 'onTaskComplete' | 'onTaskRejected'
  > {
    return {
      onTasksAdded: (info) => {
        for (const task of info.tasks) {
          const existing = this.tasks.get(task.id);
          this.tasks.set(task.id, {
            id: task.id,
            title: task.title,
            status: task.status,
            phase: task.phase,
            agentId: existing?.agentId,
            startedAt: existing?.startedAt,
          });
        }
        this.broadcast({ type: 'tasks_updated', tasks: Array.from(this.tasks.values()) });
      },

      onTaskStart: (info) => {
        const existing = this.tasks.get(info.taskId);
        if (existing) {
          existing.status = 'implementing';
          existing.agentId = info.agentId;
          existing.startedAt = info.startedAt;
        } else {
          this.tasks.set(info.taskId, {
            id: info.taskId,
            title: info.title,
            status: 'implementing',
            phase: info.phase,
            agentId: info.agentId,
            startedAt: info.startedAt,
          });
        }
        this.broadcast({ type: 'tasks_updated', tasks: Array.from(this.tasks.values()) });
      },

      onTaskComplete: (info) => {
        const existing = this.tasks.get(info.taskId);
        if (existing) {
          existing.status = 'done';
        } else {
          this.tasks.set(info.taskId, {
            id: info.taskId,
            title: info.title,
            status: 'done',
          });
        }
        this.broadcast({ type: 'tasks_updated', tasks: Array.from(this.tasks.values()) });
      },

      onTaskRejected: (info) => {
        const existing = this.tasks.get(info.taskId);
        if (existing) {
          existing.status = 'failed';
        } else {
          this.tasks.set(info.taskId, {
            id: info.taskId,
            title: info.title,
            status: 'failed',
          });
        }
        this.broadcast({ type: 'tasks_updated', tasks: Array.from(this.tasks.values()) });
      },
    };
  }

  /**
   * Build an `init` message from accumulated state.
   */
  getSnapshot(): ServerMessage & { type: 'init' } {
    return {
      type: 'init',
      currentPhase: this.currentPhase,
      completedPhases: [...this.completedPhases],
      tasks: Array.from(this.tasks.values()),
      agents: Array.from(this.agents.values()),
      sidebar: { ...this.sidebar },
    };
  }

  // ─── Private helpers ──────────────────────────────────────────────────────

  /**
   * Search the agents map for an entry with matching agentId (ignoring taskId in the key)
   * and return its taskId, or undefined if not found.
   */
  private findTaskIdForAgent(agentId: string): string | undefined {
    for (const agent of this.agents.values()) {
      if (agent.agentId === agentId) {
        return agent.taskId;
      }
    }
    return undefined;
  }

  private appendAgentLog(agentId: string, taskId: string | undefined, entry: LogEntry): void {
    const key = agentKey(agentId, taskId);
    const agent = this.agents.get(key);
    if (agent) {
      agent.log.push(entry);
    }
  }

  private blockToEntry(block: TurnContentBlock): LogEntry | undefined {
    if (block.type === 'text') {
      return {
        id: `text-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        timestamp: new Date().toISOString(),
        type: 'text',
        content: block.text,
      };
    }
    if (block.type === 'thinking') {
      return {
        id: `thinking-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        timestamp: new Date().toISOString(),
        type: 'thinking',
        content: block.thinking,
      };
    }
    if (block.type === 'toolCall') {
      return {
        id: block.id,
        timestamp: new Date().toISOString(),
        type: 'tool_call',
        content: block.name,
        metadata: { arguments: block.arguments },
      };
    }
    return undefined;
  }
}
