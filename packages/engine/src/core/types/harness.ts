import type { AgentStatusCallbacks } from './callbacks.js';
import type { AgentProfile } from './profiles.js';

export interface HarnessCreationOptions {
  profile: AgentProfile;
  cwd: string;
  apiKeys?: Record<string, string>;
  onAgentStatus?: AgentStatusCallbacks;
  sessionDir?: string;
  resumeSessionPath?: string;
  /** Override agent ID used in status callbacks. Defaults to sessionId if not provided. */
  agentId?: string;
  /**
   * Optional write sandbox: when set, `write`/`edit` tool calls whose target
   * path resolves outside these directories are blocked (the agent receives an
   * error tool result and may retry inside the sandbox). Paths are resolved
   * against `cwd`. Use to confine an agent's file mutations (e.g. a planner
   * that should only write into a run's artifacts directory).
   */
  allowedWriteDirs?: string[];
}
