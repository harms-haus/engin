// ─── Tests for core/agent-registry.ts — module-level plugin registry ────────
//
// Validates the lightweight module-level agent plugin registry modeled after
// renderer-registry.ts. These tests verify:
//
//   1. `registerAgentPlugin` stores a plugin keyed by its id.
//   2. `getAgentPlugin` retrieves a registered plugin and returns undefined
//      for unknown ids.
//   3. `hasAgentPlugin` reports existence accurately.
//   4. `DEFAULT_AGENT_PLUGIN_ID` equals `'pi-coding-agent'`.
//   5. `requireAgentPlugin` falls back to the default id when given undefined.
//   6. `requireAgentPlugin` throws a descriptive Error (listing registered
//      ids) when no plugin matches.
//   7. `requireAgentPlugin` returns the resolved plugin.
//   8. `clearAgentPluginRegistry` empties the registry.
//
// Module under test: ./agent-registry.js

import { afterEach, describe, expect, it } from 'bun:test';

import type { AgentPlugin, AgentRuntime, AgentSessionOptions } from './agent-plugin.js';
import {
  clearAgentPluginRegistry,
  DEFAULT_AGENT_PLUGIN_ID,
  getAgentPlugin,
  hasAgentPlugin,
  registerAgentPlugin,
  requireAgentPlugin,
} from './agent-registry.js';

// ─── Helpers ───────────────────────────────────────────────────────────────

/** Build a minimal mock AgentPlugin with the given id. */
function makePlugin(id: string): AgentPlugin {
  return {
    id,
    async createSession(_opts: AgentSessionOptions): Promise<AgentRuntime> {
      return {
        sessionId: `${id}-session`,
        async prompt() {},
        getLastAssistantText: () => undefined,
        getLastAssistantMessage: () => undefined,
        async abort() {},
        dispose() {},
        subscribe: () => () => {},
      };
    },
  };
}

// Ensure a clean registry between every test so they remain independent.
afterEach(() => {
  clearAgentPluginRegistry();
});

// ─── DEFAULT_AGENT_PLUGIN_ID ───────────────────────────────────────────────

describe('DEFAULT_AGENT_PLUGIN_ID', () => {
  it('equals "pi-coding-agent"', () => {
    expect(DEFAULT_AGENT_PLUGIN_ID).toBe('pi-coding-agent');
  });
});

// ─── registerAgentPlugin / getAgentPlugin ──────────────────────────────────

describe('registerAgentPlugin / getAgentPlugin', () => {
  it('registers and retrieves a plugin by id', () => {
    const plugin = makePlugin('alpha');
    registerAgentPlugin(plugin);

    expect(getAgentPlugin('alpha')).toBe(plugin);
  });

  it('returns undefined for an unknown id', () => {
    expect(getAgentPlugin('does-not-exist')).toBeUndefined();
  });

  it('overwrites a previously registered plugin with the same id', () => {
    const first = makePlugin('shared');
    const second = makePlugin('shared');

    registerAgentPlugin(first);
    expect(getAgentPlugin('shared')).toBe(first);

    registerAgentPlugin(second);
    expect(getAgentPlugin('shared')).toBe(second);
  });
});

// ─── hasAgentPlugin ────────────────────────────────────────────────────────

describe('hasAgentPlugin', () => {
  it('returns false when the registry is empty', () => {
    expect(hasAgentPlugin('anything')).toBe(false);
  });

  it('returns true for a registered id', () => {
    registerAgentPlugin(makePlugin('beta'));
    expect(hasAgentPlugin('beta')).toBe(true);
  });

  it('returns false for an id that was never registered', () => {
    registerAgentPlugin(makePlugin('beta'));
    expect(hasAgentPlugin('gamma')).toBe(false);
  });
});

// ─── requireAgentPlugin ────────────────────────────────────────────────────

describe('requireAgentPlugin', () => {
  it('returns the plugin for a registered id', () => {
    const plugin = makePlugin('delta');
    registerAgentPlugin(plugin);

    expect(requireAgentPlugin('delta')).toBe(plugin);
  });

  it('falls back to DEFAULT_AGENT_PLUGIN_ID when id is undefined', () => {
    const defaultPlugin = makePlugin(DEFAULT_AGENT_PLUGIN_ID);
    registerAgentPlugin(defaultPlugin);

    expect(requireAgentPlugin(undefined)).toBe(defaultPlugin);
  });

  it('throws a descriptive Error when the resolved id is not registered', () => {
    registerAgentPlugin(makePlugin('one'));
    registerAgentPlugin(makePlugin('two'));

    let thrown: unknown;
    try {
      requireAgentPlugin('missing');
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(Error);
    const message = (thrown as Error).message;
    // Mentions the requested id.
    expect(message).toContain('missing');
    // Lists all currently registered ids to aid debugging.
    expect(message).toContain('one');
    expect(message).toContain('two');
  });

  it('throws when falling back to the default id that is not registered', () => {
    let thrown: unknown;
    try {
      requireAgentPlugin(undefined);
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain(DEFAULT_AGENT_PLUGIN_ID);
  });

  it('throws an Error even when the registry is empty', () => {
    expect(() => requireAgentPlugin('solo')).toThrow(Error);
  });
});

// ─── clearAgentPluginRegistry ──────────────────────────────────────────────

describe('clearAgentPluginRegistry', () => {
  it('removes all registered plugins', () => {
    registerAgentPlugin(makePlugin('a'));
    registerAgentPlugin(makePlugin('b'));
    expect(hasAgentPlugin('a')).toBe(true);

    clearAgentPluginRegistry();

    expect(hasAgentPlugin('a')).toBe(false);
    expect(hasAgentPlugin('b')).toBe(false);
    expect(getAgentPlugin('a')).toBeUndefined();
  });

  it('is safe to call on an empty registry', () => {
    expect(() => clearAgentPluginRegistry()).not.toThrow();
  });

  it('allows re-registration after clearing', () => {
    const original = makePlugin('recycled');
    registerAgentPlugin(original);
    clearAgentPluginRegistry();
    expect(hasAgentPlugin('recycled')).toBe(false);

    const replacement = makePlugin('recycled');
    registerAgentPlugin(replacement);
    expect(getAgentPlugin('recycled')).toBe(replacement);
  });
});
