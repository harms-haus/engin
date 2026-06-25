// ─── Agents barrel — built-in adapter registration + registry API ───────────
//
// Importing this module triggers the side-effect imports of every built-in
// adapter, each of which self-registers with the engine's agent plugin
// registry via `registerAgentPlugin`. Re-exporting the registry API and the
// event forwarder here gives consumers a single import surface for the agent
// system.

// Side-effect imports: each adapter self-registers via registerAgentPlugin.
import './codex/adapter.js';
import './cursor/adapter.js';
import './pi-coding-agent/adapter.js';

// Re-export adapter types/functions for consumers that need direct access.
export { createAgentEventForwarder } from '../core/agent-event-forwarder.js';
export type { AgentPlugin, AgentRuntime, AgentRuntimeEvent, AgentSessionOptions } from '../core/agent-plugin.js';
export {
  DEFAULT_AGENT_PLUGIN_ID,
  getAgentPlugin,
  hasAgentPlugin,
  registerAgentPlugin,
  requireAgentPlugin,
} from '../core/agent-registry.js';
