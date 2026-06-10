import type { StatusCallbacks, TurnContentBlock } from '../core/types.js';
import type { RunRegistry } from './run-registry.js';
import type { AgentWindowState, LogEntry, ServerMessage } from './types.js';

/**
 * Create a `StatusCallbacks` object that forwards every lifecycle event to
 * the given `RunRegistry` (for state tracking) and broadcasts the
 * corresponding `ServerMessage` to connected WebSocket clients.
 */
export function createStatusBridge(
  runId: string,
  registry: RunRegistry,
  broadcast: (msg: ServerMessage) => void,
): StatusCallbacks {
  return {
    // ─── No-op callbacks ──────────────────────────────────────────────────

    onWorkflowStart() {
      /* noop */
    },
    onWorkflowComplete() {
      /* noop */
    },
    onWorkflowFailed() {
      /* noop */
    },
    onTaskStart() {
      /* noop */
    },
    onTaskComplete() {
      /* noop */
    },
    onTaskRejected() {
      /* noop */
    },
    onTurnStart() {
      /* noop */
    },

    // ─── Phase ────────────────────────────────────────────────────────────

    onPhaseStart(info) {
      registry.setPhase(runId, info.phase);
      broadcast({
        type: 'workflow_phase',
        workflowId: runId,
        phase: info.phase,
        completed: [
          ...(
            registry.getRun(runId) ??
            (() => {
              throw new Error(`Run ${runId} not found`);
            })()
          ).completedPhases,
        ],
      });
    },

    onPhaseComplete(info) {
      broadcast({
        type: 'workflow_phase',
        workflowId: runId,
        phase: info.phase,
        completed: [
          ...(
            registry.getRun(runId) ??
            (() => {
              throw new Error(`Run ${runId} not found`);
            })()
          ).completedPhases,
        ],
      });
    },

    // ─── Agents ───────────────────────────────────────────────────────────

    onAgentSpawn(info) {
      const agent: AgentWindowState = {
        agentId: info.agentId,
        profile: info.profile,
        taskId: info.taskId,
        active: true,
        log: [],
      };
      registry.addAgent(runId, agent);
      broadcast({ type: 'agent_spawned', workflowId: runId, agent });
    },

    onAgentComplete(info) {
      registry.completeAgent(runId, info.agentId);
      broadcast({
        type: 'agent_complete',
        workflowId: runId,
        agentId: info.agentId,
      });
    },

    // ─── Turns ────────────────────────────────────────────────────────────

    onTurnEnd(info) {
      if (!info.contentBlocks || info.contentBlocks.length === 0) return;

      for (const block of info.contentBlocks) {
        const entry = contentBlockToLogEntry(block);
        registry.addAgentLogEntry(runId, info.agentId, entry);
        broadcast({
          type: 'agent_log',
          workflowId: runId,
          agentId: info.agentId,
          entry,
        });
      }
    },

    // ─── Tool calls ──────────────────────────────────────────────────────

    onToolCallStart(info) {
      const entry: LogEntry = {
        id: info.toolCallId,
        timestamp: new Date().toISOString(),
        type: 'tool_call_start',
        content: info.toolName,
      };
      registry.addAgentLogEntry(runId, info.agentId, entry);
      broadcast({
        type: 'agent_log',
        workflowId: runId,
        agentId: info.agentId,
        entry,
      });
    },

    onToolCallEnd(info) {
      const entry: LogEntry = {
        id: info.toolCallId + '-end',
        timestamp: new Date().toISOString(),
        type: 'tool_call_end',
        content: info.toolName,
        metadata: { isError: info.isError },
      };
      registry.addAgentLogEntry(runId, info.agentId, entry);
      broadcast({
        type: 'agent_log',
        workflowId: runId,
        agentId: info.agentId,
        entry,
      });
    },

    // ─── Errors ──────────────────────────────────────────────────────────

    onError(info) {
      const entry: LogEntry = {
        id: crypto.randomUUID(),
        timestamp: new Date().toISOString(),
        type: 'error',
        content: info.error,
        metadata: { phase: info.phase },
      };
      registry.addAgentLogEntry(runId, info.agentId, entry);
      broadcast({
        type: 'agent_log',
        workflowId: runId,
        agentId: info.agentId,
        entry,
      });
    },

    // ─── Decisions ───────────────────────────────────────────────────────

    onDecision(info) {
      const entry: LogEntry = {
        id: crypto.randomUUID(),
        timestamp: new Date().toISOString(),
        type: 'decision',
        content: info.decision,
        metadata: { reasoning: info.reasoning },
      };
      registry.addAgentLogEntry(runId, info.agentId, entry);
      broadcast({
        type: 'agent_log',
        workflowId: runId,
        agentId: info.agentId,
        entry,
      });
    },

    // ─── Sidebar ─────────────────────────────────────────────────────────

    onSidebarUpdate(info) {
      registry.updateSidebar(runId, info);
      broadcast({
        type: 'workflow_sidebar',
        workflowId: runId,
        sidebar: (
          registry.getRun(runId) ??
          (() => {
            throw new Error(`Run ${runId} not found`);
          })()
        ).sidebar,
      });
    },
  };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Map a `TurnContentBlock` to a `LogEntry`.
 */
function contentBlockToLogEntry(block: TurnContentBlock): LogEntry {
  switch (block.type) {
    case 'text':
      return {
        id: crypto.randomUUID(),
        timestamp: new Date().toISOString(),
        type: 'text',
        content: block.text,
      };
    case 'thinking':
      return {
        id: crypto.randomUUID(),
        timestamp: new Date().toISOString(),
        type: 'thinking',
        content: block.redacted ? '[redacted]' : block.thinking,
      };
    case 'toolCall':
      return {
        id: crypto.randomUUID(),
        timestamp: new Date().toISOString(),
        type: 'tool_call',
        content: block.name,
        metadata: { arguments: block.arguments },
      };
  }
}
