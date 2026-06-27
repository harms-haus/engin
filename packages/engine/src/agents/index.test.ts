// ─── Tests for sessions/index.ts — adapter registration wiring ────────────────
//
// Verifies that the `sessions/index.ts` barrel:
//   1. Triggers self-registration of all three built-in adapters
//      (pi-coding-agent, codex, cursor) as a side-effect of import — both when
//      importing the sessions barrel directly and when importing the engine
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

import { beforeEach, describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// ─── Import the barrels under test ──────────────────────────────────────────
//
// Importing the sessions barrel triggers the side-effect imports of each adapter
// module, which self-register via `registerAgentPlugin`. Importing the engine
// barrel must likewise trigger registration because `index.ts` re-exports
// `./sessions/index.js`.

import type * as AgentRegistryNS from '../core/agent-registry.js';
import {
  DEFAULT_AGENT_PLUGIN_ID,
  getAgentPlugin,
  hasAgentPlugin,
  registerAgentPlugin,
  requireAgentPlugin,
} from '../core/agent-registry.js';
import * as engineBarrel from '../index.js';
import * as agentsBarrel from './index.js';
// bun's `mock.module` is process-global: sibling test files mock this
// module's `requireAgentPlugin` at import time, which leaks and replaces the
// real function for the whole process. The identity tests (barrel re-exports
// the SAME function instances) must use the bare import so both sides match;
// the BEHAVIORAL requireAgentPlugin tests (resolves ids, throws for unknown)
// need the REAL function — a fresh, un-mocked instance via a query suffix
// provides it, with its own registry Map populated in beforeEach below. (tsc
// cannot resolve the query string; bun resolves it to the same source file.)
// @ts-expect-error query-suffix module specifier is resolved by bun at runtime
const IsolatedRegistry = (await import('../core/agent-registry.js?isolated')) as typeof AgentRegistryNS;
/** Real (un-mocked) requireAgentPlugin for behavioral tests. */
const isolatedRequireAgentPlugin = IsolatedRegistry.requireAgentPlugin;

// ─── Adapter imports for resilient re-registration ──────────────────────────
//
// When this file runs alongside agent-registry.test.ts (which calls
// `clearAgentPluginRegistry()` in its afterEach), the module-level side-effect
// registrations from the barrel import may have been wiped before these tests
// execute. Importing the adapter objects directly lets us re-register them
// before each test, ensuring the registry is always populated.

import { codexAdapter } from './codex/adapter.js';
import { cursorAdapter } from './cursor/adapter.js';
import { piCodingAgentAdapter } from './pi-coding-agent/adapter.js';

// ─── Paths ──────────────────────────────────────────────────────────────────

const here = dirname(fileURLToPath(import.meta.url));
const engineIndexPath = resolve(here, '..', 'index.ts');

/** The built-in adapter ids that must self-register on barrel import. */
const BUILTIN_ADAPTER_IDS = ['pi-coding-agent', 'codex', 'cursor'] as const;

// ─── Re-register adapters before each test ─────────────────────────────────
//
// Guard against cross-file registry clearing (e.g. agent-registry.test.ts
// calling `clearAgentPluginRegistry()` in afterEach). The module-level
// side-effect imports run once at load time; a parallel test file may wipe
// the registry before these tests execute.

beforeEach(() => {
  registerAgentPlugin(piCodingAgentAdapter);
  registerAgentPlugin(codexAdapter);
  registerAgentPlugin(cursorAdapter);
  // Also populate the isolated (un-mocked) registry instance used by the
  // behavioral requireAgentPlugin tests below.
  IsolatedRegistry.registerAgentPlugin(piCodingAgentAdapter);
  IsolatedRegistry.registerAgentPlugin(codexAdapter);
  IsolatedRegistry.registerAgentPlugin(cursorAdapter);
});

// ─── Adapter registration via the sessions barrel ────────────────────────────

describe('sessions/index.ts — adapter self-registration', () => {
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
      const plugin = isolatedRequireAgentPlugin(id);
      expect(plugin.id).toBe(id);
    }
  });

  it('requireAgentPlugin throws for an unknown id', () => {
    expect(() => isolatedRequireAgentPlugin('does-not-exist')).toThrow();
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
    expect(isolatedRequireAgentPlugin('pi-coding-agent').id).toBe('pi-coding-agent');
    expect(isolatedRequireAgentPlugin('codex').id).toBe('codex');
    expect(isolatedRequireAgentPlugin('cursor').id).toBe('cursor');
  });
});

// ─── sessions/index.ts re-export surface ─────────────────────────────────────

describe('sessions/index.ts — re-exported registry API', () => {
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

  // removed in C2 per §2.14 — the sessions barrel was folded into ./agents/index.js;
  // the engine barrel re-exports ./agents/index.js (tested by the Core section test above).
});
