import type { AgentProfile } from './profiles.js';

export type AuditEvent =
  | {
      type: 'agent_start';
      agentId: string;
      profile: AgentProfile;
      taskId?: string;
      timestamp: string;
      phaseId?: string;
    }
  | { type: 'agent_end'; agentId: string; result: unknown; taskId?: string; timestamp: string; phaseId?: string }
  | { type: 'decision'; agentId: string; decision: string; reasoning: string; taskId?: string; timestamp: string }
  | { type: 'structured_output'; agentId: string; output: unknown; taskId?: string; timestamp: string }
  | { type: 'error'; agentId: string; error: string; taskId?: string; timestamp: string };
