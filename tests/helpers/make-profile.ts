import type { AgentProfile } from '../../packages/engine/src/core/types.js';

/**
 * Creates an AgentProfile with sensible defaults.
 */
export function makeProfile(overrides?: Partial<AgentProfile>): AgentProfile {
  return {
    id: 'test-agent',
    name: 'Test Agent',
    provider: 'openai',
    model: 'gpt-4o',
    thinkingLevel: 'medium',
    systemPrompt: 'You are a test agent.',
    excludeTools: [],
    includeTools: [],
    ...overrides,
  };
}
