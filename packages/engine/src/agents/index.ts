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

// ─── Write-sandbox utilities ──────────────────────────────────────────────────
//
// General-purpose path-safety helpers that enforce write-sandbox boundaries.
// Re-exported here so custom agent plugins, workflows, and other consumers can
// import them from the agents barrel or the engine entrypoint rather than from
// the deep internal path under `pi-coding-agent/`.

export {
  canonicalizePath,
  createWriteSandboxExtension,
  findAllowedDir,
  isPathWithin,
  resolveAllowedDirs,
  resolveToolPath,
} from './pi-coding-agent/write-sandbox.js';
export type { WriteSandboxOptions } from './pi-coding-agent/write-sandbox.js';
