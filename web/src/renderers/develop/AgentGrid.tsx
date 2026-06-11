/**
 * AgentGrid component.
 *
 * Renders a CSS Grid of agent log panels. Each cell shows an AgentLog
 * with a header containing the agent's profile name and an active/inactive
 * status dot. When there are no agents a centered empty-state message is
 * displayed.
 */

import './AgentGrid.css';
import { AgentLog } from './AgentLog';
import type { DevelopAgentInfo } from './types';
import { agentKey } from '../../utils/agent-key';

interface AgentGridProps {
  agents: DevelopAgentInfo[];
  emptyMessage?: string;
}

export function AgentGrid({ agents, emptyMessage }: AgentGridProps) {
  if (agents.length === 0) {
    return <div className="agent-grid-empty">{emptyMessage ?? 'No active agents'}</div>;
  }

  return (
    <div className="agent-grid">
      {agents.map((agent) => (
        <div key={agentKey(agent.agentId, agent.taskId)} className="agent-cell">
          <div className="agent-cell-header">
            <span className="agent-cell-header-name">
              <span
                className={`agent-cell-status-dot agent-cell-status-dot--${agent.active ? 'active' : 'inactive'}`}
                role="status"
                aria-label={agent.active ? 'Active' : 'Completed'}
              />
              {agent.profile}
            </span>
          </div>
          <div className="agent-cell-body">
            <AgentLog entries={agent.log} />
          </div>
        </div>
      ))}
    </div>
  );
}
