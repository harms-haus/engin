export type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';

export interface AgentProfile {
  id: string;
  name: string;
  provider: string;
  model: string;
  /** Agent runtime plugin id. Defaults to 'pi-coding-agent' when omitted. */
  agent?: string;
  thinkingLevel: ThinkingLevel;
  systemPrompt: string;
  excludeTools: string[];
  includeTools: string[];
}
