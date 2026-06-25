// ─── Agent Plugin Registry ──────────────────────────────────────────────────
//
// Module-level plugin registry for agent adapters. Modeled after
// renderer-registry.ts. Plugins are stored in a module-level Map keyed
// by their unique plugin id.
//
// Users register a plugin once during initialisation, then resolve it
// elsewhere by id (or by the well-known default id) when they need to
// create an AgentRuntime session.

import type { AgentPlugin } from './agent-plugin.js';

// ─── Registry ──────────────────────────────────────────────────────────────

/** Module-level registry of agent plugins, keyed by plugin id. */
const registry = new Map<string, AgentPlugin>();

// ─── Default ───────────────────────────────────────────────────────────────

/**
 * The default agent plugin id. Used by {@link requireAgentPlugin} when no
 * explicit id is provided.
 */
export const DEFAULT_AGENT_PLUGIN_ID = 'pi-coding-agent';

// ─── Public API ────────────────────────────────────────────────────────────

/**
 * Register an agent plugin. If a plugin with the same `id` already exists
 * it is overwritten.
 *
 * @param plugin  The plugin instance to register.
 */
export function registerAgentPlugin(plugin: AgentPlugin): void {
  registry.set(plugin.id, plugin);
}

/**
 * Retrieve a registered agent plugin by id.
 *
 * @param id  The plugin identifier.
 * @returns   The plugin if found, otherwise `undefined`.
 */
export function getAgentPlugin(id: string): AgentPlugin | undefined {
  return registry.get(id);
}

/**
 * Check whether a plugin with the given id is registered.
 *
 * @param id  The plugin identifier.
 * @returns   `true` if a plugin with that id exists in the registry.
 */
export function hasAgentPlugin(id: string): boolean {
  return registry.has(id);
}

/**
 * Resolve an agent plugin by id, falling back to {@link DEFAULT_AGENT_PLUGIN_ID}
 * when `id` is `undefined`. Throws a descriptive error if the resolved id is
 * not registered, listing all currently registered ids.
 *
 * @param id  The plugin identifier (or `undefined` to use the default).
 * @returns   The registered plugin.
 * @throws    Error if no plugin is registered for the resolved id.
 */
export function requireAgentPlugin(id: string | undefined): AgentPlugin {
  const resolvedId = id ?? DEFAULT_AGENT_PLUGIN_ID;
  const plugin = registry.get(resolvedId);
  if (!plugin) {
    const registered = [...registry.keys()];
    const msg =
      registered.length === 0
        ? `No agent plugin registered for "${resolvedId}" and the registry is empty.`
        : `No agent plugin registered for "${resolvedId}". Registered plugins: ${registered.join(', ')}`;
    throw new Error(msg);
  }
  return plugin;
}

/**
 * Clear all registered plugins from the registry. Intended for testing.
 */
export function clearAgentPluginRegistry(): void {
  registry.clear();
}
