// ─── Tests for agents/index.ts — adapter registration wiring ────────────────
//
// Verifies that the `agents/index.ts` barrel:
//   1. Triggers self-registration of all three built-in adapters
//      (pi-coding-agent, codex, cursor) as a side-effect of import — both when
//      importing the agents barrel directly and when importing the engine
//      package barrel (`src/index.ts`), which must re-export it.
//   2. Re-exports the agent-registry API and the event forwarder so consumers
//      have a single import surface.
//
// Also guards the engine `index.ts` public surface cleanup:
//   - `core/harness-factory.js` is no longer exported from the engine barrel.
//   - `core/write-sandbox.js` is no longer exported from the engine barrel
//     (the write-sandbox module now lives under the adapter directory).
//
// Module under test: ./index.js (and ../index.js for the engine barrel).

import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// ─── Import the barrels under test ──────────────────────────────────────────
//
// Importing the agents barrel triggers the side-effect imports of each adapter
// module, which self-register via `registerAgentPlugin`. Importing the engine
// barrel must likewise trigger registration because `index.ts` re-exports
// `./agents/index.js`.

import { DEFAULT_AGENT_PLUGIN_ID, getAgentPlugin, hasAgentPlugin, requireAgentPlugin } from '../core/agent-registry.js';
import * as engineBarrel from '../index.js';
import * as agentsBarrel from './index.js';

// ─── Paths ──────────────────────────────────────────────────────────────────

const here = dirname(fileURLToPath(import.meta.url));
const engineIndexPath = resolve(here, '..', 'index.ts');

/** The built-in adapter ids that must self-register on barrel import. */
const BUILTIN_ADAPTER_IDS = ['pi-coding-agent', 'codex', 'cursor'] as const;

// ─── Adapter registration via the agents barrel ────────────────────────────

describe('agents/index.ts — adapter self-registration', () => {
  it('registers every built-in adapter as a side-effect of import', () => {
    for (const id of BUILTIN_ADAPTER_IDS) {
      expect(hasAgentPlugin(id), `expected "${id}" to be registered`).toBe(true);
    }
  });

  it('getAgentPlugin returns the plugin object for each built-in id', () => {
    for (const id of BUILTIN_ADAPTER_IDS) {
      const plugin = getAgentPlugin(id);
      expect(plugin, `expected plugin for "${id}"`).toBeDefined();
      expect(plugin!.id).toBe(id);
      expect(typeof plugin!.createSession).toBe('function');
    }
  });

  it('requireAgentPlugin resolves each built-in id without throwing', () => {
    for (const id of BUILTIN_ADAPTER_IDS) {
      const plugin = requireAgentPlugin(id);
      expect(plugin.id).toBe(id);
    }
  });

  it('requireAgentPlugin throws for an unknown id', () => {
    expect(() => requireAgentPlugin('does-not-exist')).toThrow();
  });

  it('DEFAULT_AGENT_PLUGIN_ID points at the pi-coding-agent adapter', () => {
    expect(DEFAULT_AGENT_PLUGIN_ID).toBe('pi-coding-agent');
    // requireAgentPlugin(undefined) resolves to the default.
    expect(requireAgentPlugin(undefined).id).toBe('pi-coding-agent');
  });
});

// ─── Adapter registration via the engine package barrel ────────────────────

describe('engine index.ts — import triggers adapter registration', () => {
  // This is the core wiring requirement: importing the engine package must
  // make every built-in adapter available without any additional import.

  it('the engine barrel exports an object (imports without throwing)', () => {
    expect(typeof engineBarrel).toBe('object');
    expect(engineBarrel).not.toBeNull();
  });

  it('importing the engine barrel registers every built-in adapter', () => {
    for (const id of BUILTIN_ADAPTER_IDS) {
      const plugin = getAgentPlugin(id);
      expect(plugin, `engine barrel import should register "${id}"`).toBeDefined();
      expect(plugin!.id).toBe(id);
    }
  });

  it("getAgentPlugin('codex') returns a defined plugin (smoke test)", () => {
    const codex = getAgentPlugin('codex');
    expect(codex).toBeDefined();
    expect(codex!.id).toBe('codex');
    expect(typeof codex!.createSession).toBe('function');
  });

  it('requireAgentPlugin resolves each adapter via the engine-imported registry', () => {
    expect(requireAgentPlugin('pi-coding-agent').id).toBe('pi-coding-agent');
    expect(requireAgentPlugin('codex').id).toBe('codex');
    expect(requireAgentPlugin('cursor').id).toBe('cursor');
  });
});

// ─── agents/index.ts re-export surface ─────────────────────────────────────

describe('agents/index.ts — re-exported registry API', () => {
  it('re-exports the registry functions and default id constant', () => {
    expect(agentsBarrel.registerAgentPlugin).toBeInstanceOf(Function);
    expect(agentsBarrel.getAgentPlugin).toBeInstanceOf(Function);
    expect(agentsBarrel.requireAgentPlugin).toBeInstanceOf(Function);
    expect(agentsBarrel.hasAgentPlugin).toBeInstanceOf(Function);
    expect(agentsBarrel.DEFAULT_AGENT_PLUGIN_ID).toBe('pi-coding-agent');
  });

  it('re-exports createAgentEventForwarder', () => {
    expect(agentsBarrel.createAgentEventForwarder).toBeInstanceOf(Function);
  });

  it('the re-exported functions are the same instances as the core registry', () => {
    // Ensures the barrel re-exports (not re-implements) the registry API.
    expect(agentsBarrel.getAgentPlugin).toBe(getAgentPlugin);
    expect(agentsBarrel.hasAgentPlugin).toBe(hasAgentPlugin);
    expect(agentsBarrel.requireAgentPlugin).toBe(requireAgentPlugin);
    expect(agentsBarrel.DEFAULT_AGENT_PLUGIN_ID).toBe(DEFAULT_AGENT_PLUGIN_ID);
  });

  it('the re-exported registry functions are also surfaced on the engine barrel', () => {
    expect(engineBarrel.registerAgentPlugin).toBeInstanceOf(Function);
    expect(engineBarrel.getAgentPlugin).toBeInstanceOf(Function);
    expect(engineBarrel.requireAgentPlugin).toBeInstanceOf(Function);
    expect(engineBarrel.hasAgentPlugin).toBeInstanceOf(Function);
    expect(engineBarrel.DEFAULT_AGENT_PLUGIN_ID).toBe('pi-coding-agent');
    expect(engineBarrel.createAgentEventForwarder).toBeInstanceOf(Function);
  });
});

// ─── Engine index.ts public surface cleanup ────────────────────────────────
//
// The harness-factory and core/write-sandbox modules have been removed from
// the engine barrel. We assert against the source file so the test fails fast
// if either line is accidentally reintroduced. This mirrors the task
// verification: `rg 'harness-factory|core/write-sandbox' index.ts` → empty.

describe('engine index.ts — removed exports', () => {
  const source = readFileSync(engineIndexPath, 'utf8');

  it('no longer exports core/harness-factory.js', () => {
    expect(source).not.toContain('core/harness-factory.js');
    expect(source).not.toMatch(/export\s+\*\s+from\s+['"]\.\/core\/harness-factory\.js['"]/);
  });

  it('no longer exports core/write-sandbox.js', () => {
    expect(source).not.toContain('core/write-sandbox.js');
    expect(source).not.toMatch(/export\s+\*\s+from\s+['"]\.\/core\/write-sandbox\.js['"]/);
  });

  it('re-exports the agents barrel from the Core section', () => {
    expect(source).toMatch(/export\s+\*\s+from\s+['"]\.\/agents\/index\.js['"]/);
  });
});
