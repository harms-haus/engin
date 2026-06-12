/**
 * Tests that WorkflowEntry is unified across backend and frontend.
 *
 * WorkflowEntry { name: string; source: 'local' | 'global'; path: string }
 * is canonically defined in src/core/types.ts. It must also be available
 * in the frontend via web/src/protocol-types.ts (the shared mirror file)
 * and re-exported through web/src/types.ts for backward compatibility.
 *
 * This file verifies:
 * 1. web/src/protocol-types.ts exports WorkflowEntry with the correct shape
 * 2. web/src/protocol-types.ts has the mirror comment referencing src/core/types.ts
 * 3. web/src/types.ts re-exports WorkflowEntry from protocol-types (not inline)
 * 4. Structural identity across all three sources: core, protocol-types, types
 * 5. Runtime behaviour: construction, JSON round-trips, discriminated source field
 */

import { describe, expect, it } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

// ─── Canonical: src/core/types.ts ────────────────────────────────────────────

import type { WorkflowEntry as CoreWorkflowEntry } from '../../src/core/types.js';

// ─── Frontend protocol mirror: web/src/protocol-types.ts ────────────────────

import type { WorkflowEntry as ProtocolWorkflowEntry } from '../../web/src/protocol-types.js';

// ─── Frontend re-export: web/src/types.ts ───────────────────────────────────

import type { WorkflowEntry as FrontendWorkflowEntry } from '../../web/src/types.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

const projectRoot = join(import.meta.dir, '..', '..');

/** Checks that two types are mutually assignable (structurally identical). */
function expectStructurallyIdentical<A, B>(_a: A extends B ? (B extends A ? true : never) : never): void {
  // If this function compiles, the types are structurally identical.
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('WorkflowEntry unification', () => {
  // ── File existence ──────────────────────────────────────────────────

  describe('file existence', () => {
    it('src/core/types.ts exists on disk (canonical source)', () => {
      expect(existsSync(join(projectRoot, 'src', 'core', 'types.ts'))).toBe(true);
    });

    it('web/src/protocol-types.ts exists on disk', () => {
      expect(existsSync(join(projectRoot, 'web', 'src', 'protocol-types.ts'))).toBe(true);
    });

    it('web/src/types.ts exists on disk', () => {
      expect(existsSync(join(projectRoot, 'web', 'src', 'types.ts'))).toBe(true);
    });
  });

  // ── Module resolution ───────────────────────────────────────────────

  describe('modules resolve at runtime', () => {
    it('src/core/types.js resolves dynamically', async () => {
      const mod = await import('../../src/core/types.js');
      expect(mod).toBeDefined();
      expect(typeof mod).toBe('object');
    });

    it('web/src/protocol-types.js resolves dynamically', async () => {
      const mod = await import('../../web/src/protocol-types.js');
      expect(mod).toBeDefined();
      expect(typeof mod).toBe('object');
    });

    it('web/src/types.js resolves dynamically', async () => {
      const mod = await import('../../web/src/types.js');
      expect(mod).toBeDefined();
      expect(typeof mod).toBe('object');
    });
  });

  // ── web/src/protocol-types.ts exports WorkflowEntry ─────────────────

  describe('web/src/protocol-types.ts exports WorkflowEntry', () => {
    it('has correct shape with name, source, path', () => {
      const entry: ProtocolWorkflowEntry = {
        name: 'test-workflow',
        source: 'local',
        path: './workflows/test.yaml',
      };
      expect(entry.name).toBe('test-workflow');
      expect(entry.source).toBe('local');
      expect(entry.path).toBe('./workflows/test.yaml');
    });

    it('accepts "global" source', () => {
      const entry: ProtocolWorkflowEntry = {
        name: 'global-wf',
        source: 'global',
        path: '/etc/workflows/global.yaml',
      };
      expect(entry.source).toBe('global');
    });

    it('accepts "local" source', () => {
      const entry: ProtocolWorkflowEntry = {
        name: 'local-wf',
        source: 'local',
        path: './local.yaml',
      };
      expect(entry.source).toBe('local');
    });

    it('has exactly three properties', () => {
      const entry: ProtocolWorkflowEntry = {
        name: 'x',
        source: 'local',
        path: '/x',
      };
      expect(Object.keys(entry).sort()).toEqual(['name', 'path', 'source']);
    });

    it('JSON round-trips correctly', () => {
      const entry: ProtocolWorkflowEntry = {
        name: 'round-trip',
        source: 'global',
        path: '/shared/round-trip.yaml',
      };
      const json = JSON.stringify(entry);
      const parsed = JSON.parse(json) as ProtocolWorkflowEntry;
      expect(parsed).toEqual(entry);
    });
  });

  // ── web/src/protocol-types.ts has mirror comment ────────────────────

  describe('web/src/protocol-types.ts mirror comment', () => {
    it('contains a comment referencing src/core/types.ts::WorkflowEntry', async () => {
      const fs = await import('node:fs/promises');
      const content = await fs.readFile(join(projectRoot, 'web', 'src', 'protocol-types.ts'), 'utf-8');

      // Should have a comment linking WorkflowEntry back to its canonical source
      expect(content).toMatch(/Mirrors src\/core\/types\.ts::WorkflowEntry/);
    });

    it('contains the WorkflowEntry interface definition', async () => {
      const fs = await import('node:fs/promises');
      const content = await fs.readFile(join(projectRoot, 'web', 'src', 'protocol-types.ts'), 'utf-8');
      expect(content).toContain('interface WorkflowEntry');
      expect(content).toMatch(/name:\s*string/);
      expect(content).toMatch(/source:\s*['"]local['"]\s*\|\s*['"]global['"]/);
      expect(content).toMatch(/path:\s*string/);
    });
  });

  // ── web/src/types.ts re-exports WorkflowEntry from protocol-types ───

  describe('web/src/types.ts re-exports WorkflowEntry from protocol-types', () => {
    it('re-exports WorkflowEntry via protocol-types re-export', async () => {
      const fs = await import('node:fs/promises');
      const content = await fs.readFile(join(projectRoot, 'web', 'src', 'types.ts'), 'utf-8');

      // Should re-export WorkflowEntry in the export type {} from './protocol-types' block
      expect(content).toMatch(/export\s+type\s*\{[^}]*WorkflowEntry[^}]*\}\s*from\s+['"]\.\/protocol-types/);
    });

    it('does NOT define WorkflowEntry inline', async () => {
      const fs = await import('node:fs/promises');
      const content = await fs.readFile(join(projectRoot, 'web', 'src', 'types.ts'), 'utf-8');

      // Should NOT have an inline interface WorkflowEntry definition
      expect(content).not.toMatch(/export\s+interface\s+WorkflowEntry\s*\{/);
    });

    it('still has frontend-specific types', async () => {
      const fs = await import('node:fs/promises');
      const content = await fs.readFile(join(projectRoot, 'web', 'src', 'types.ts'), 'utf-8');

      // Frontend-specific types should remain
      expect(content).toContain('WorkflowRunState');
      expect(content).toContain('AppGlobalState');
      expect(content).toContain('isServerMessage');
    });
  });

  // ── Structural identity across all sources ─────────────────────────

  describe('structural identity across all sources', () => {
    it('core::WorkflowEntry ≡ protocol-types::WorkflowEntry', () => {
      expectStructurallyIdentical<CoreWorkflowEntry, ProtocolWorkflowEntry>(true);
    });

    it('core::WorkflowEntry ≡ frontend types::WorkflowEntry', () => {
      expectStructurallyIdentical<CoreWorkflowEntry, FrontendWorkflowEntry>(true);
    });

    it('protocol-types::WorkflowEntry ≡ frontend types::WorkflowEntry', () => {
      expectStructurallyIdentical<ProtocolWorkflowEntry, FrontendWorkflowEntry>(true);
    });

    it('all three are mutually assignable', () => {
      // Compile-time proof: assign values across all three type aliases
      const core: CoreWorkflowEntry = { name: 'a', source: 'local', path: '/a' };
      const proto: ProtocolWorkflowEntry = core;
      const frontend: FrontendWorkflowEntry = proto;
      const roundTripped: CoreWorkflowEntry = frontend;

      expect(roundTripped.name).toBe('a');
      expect(roundTripped.source).toBe('local');
      expect(roundTripped.path).toBe('/a');
    });
  });

  // ── Runtime value tests using all three type aliases ────────────────

  describe('runtime values work with all type aliases', () => {
    it('core WorkflowEntry values satisfy all three types', () => {
      const entry: CoreWorkflowEntry = {
        name: 'build',
        source: 'local',
        path: './workflows/build.yaml',
      };

      const asProto: ProtocolWorkflowEntry = entry;
      const asFrontend: FrontendWorkflowEntry = entry;

      expect(asProto.name).toBe('build');
      expect(asFrontend.source).toBe('local');
    });

    it('protocol-types WorkflowEntry values satisfy all three types', () => {
      const entry: ProtocolWorkflowEntry = {
        name: 'deploy',
        source: 'global',
        path: '/opt/workflows/deploy.yaml',
      };

      const asCore: CoreWorkflowEntry = entry;
      const asFrontend: FrontendWorkflowEntry = entry;

      expect(asCore.name).toBe('deploy');
      expect(asFrontend.path).toBe('/opt/workflows/deploy.yaml');
    });

    it('frontend types WorkflowEntry values satisfy all three types', () => {
      const entry: FrontendWorkflowEntry = {
        name: 'review',
        source: 'local',
        path: '.engin/workflows/review.yaml',
      };

      const asCore: CoreWorkflowEntry = entry;
      const asProto: ProtocolWorkflowEntry = entry;

      expect(asCore.name).toBe('review');
      expect(asProto.path).toBe('.engin/workflows/review.yaml');
    });

    it('arrays of WorkflowEntry from each source are interchangeable', () => {
      const coreEntries: CoreWorkflowEntry[] = [
        { name: 'a', source: 'local', path: './a.yaml' },
        { name: 'b', source: 'global', path: '/b.yaml' },
      ];

      const protoEntries: ProtocolWorkflowEntry[] = coreEntries;
      const frontendEntries: FrontendWorkflowEntry[] = coreEntries;

      expect(protoEntries).toHaveLength(2);
      expect(frontendEntries).toHaveLength(2);
      expect(protoEntries[0].name).toBe('a');
      expect(frontendEntries[1].source).toBe('global');
    });
  });

  // ── source field discriminated values ────────────────────────────────

  describe('source field discrimination', () => {
    it('source can be exhaustively matched as "local" | "global"', () => {
      const entries: ProtocolWorkflowEntry[] = [
        { name: 'local-wf', source: 'local', path: './local.yaml' },
        { name: 'global-wf', source: 'global', path: '/global.yaml' },
      ];

      const local = entries.filter((e) => e.source === 'local');
      const global = entries.filter((e) => e.source === 'global');

      expect(local).toHaveLength(1);
      expect(global).toHaveLength(1);
      expect(local[0].name).toBe('local-wf');
      expect(global[0].name).toBe('global-wf');
    });

    it('source values are string type at runtime', () => {
      const entry: ProtocolWorkflowEntry = { name: 'x', source: 'local', path: '/x' };
      expect(typeof entry.source).toBe('string');
    });
  });

  // ── src/core/types.ts remains unchanged (canonical) ──────────────────

  describe('src/core/types.ts is unchanged as canonical source', () => {
    it('still exports WorkflowEntry inline', async () => {
      const fs = await import('node:fs/promises');
      const content = await fs.readFile(join(projectRoot, 'src', 'core', 'types.ts'), 'utf-8');

      // The canonical source should still have its own WorkflowEntry definition
      expect(content).toContain('interface WorkflowEntry');
      expect(content).toMatch(/name:\s*string/);
      expect(content).toMatch(/source:\s*['"]local['"]\s*\|\s*['"]global['"]/);
      expect(content).toMatch(/path:\s*string/);
    });
  });

  // ── isServerMessage type guard still works ──────────────────────────

  describe('web/src/types.ts still exports isServerMessage', () => {
    it('isServerMessage function is importable', async () => {
      const { isServerMessage } = await import('../../web/src/types.js');
      expect(typeof isServerMessage).toBe('function');
    });

    it('isServerMessage works with init message carrying WorkflowSummary[]', async () => {
      const { isServerMessage } = await import('../../web/src/types.js');
      const msg = {
        type: 'init',
        workflows: [
          {
            id: 'wf-1',
            workflowName: 'test',
            status: 'running',
            sidebar: { title: 'Test', indicator: 'blue' },
            startedAt: '2026-06-11T00:00:00Z',
          },
        ],
      };

      expect(isServerMessage(msg)).toBe(true);
    });
  });

  // ── Complete integration: WorkflowEntry used via frontend types ──────

  describe('integration: WorkflowEntry via frontend types re-export', () => {
    it('can build a list of workflow entries using re-exported type', () => {
      const entries: FrontendWorkflowEntry[] = [
        { name: 'build', source: 'local', path: './workflows/build.yaml' },
        { name: 'deploy', source: 'local', path: './workflows/deploy.yaml' },
        { name: 'shared', source: 'global', path: '/opt/workflows/shared.yaml' },
      ];

      expect(entries).toHaveLength(3);

      const names = entries.map((e) => e.name);
      expect(names).toEqual(['build', 'deploy', 'shared']);

      const localOnly = entries.filter((e) => e.source === 'local');
      expect(localOnly).toHaveLength(2);
    });

    it('is destructureable via re-exported type', () => {
      const entry: FrontendWorkflowEntry = {
        name: 'test',
        source: 'global',
        path: '/shared/test.yaml',
      };

      const { name, source, path } = entry;
      expect(name).toBe('test');
      expect(source).toBe('global');
      expect(path).toBe('/shared/test.yaml');
    });

    it('spreads correctly with overrides', () => {
      const base: FrontendWorkflowEntry = {
        name: 'base',
        source: 'local',
        path: './base.yaml',
      };

      const override: FrontendWorkflowEntry = { ...base, name: 'override' };
      expect(override.name).toBe('override');
      expect(override.source).toBe('local');
      expect(override.path).toBe('./base.yaml');
    });

    it('JSON round-trips via re-exported type', () => {
      const entry: FrontendWorkflowEntry = {
        name: 'json-test',
        source: 'global',
        path: '/etc/workflows/json-test.yaml',
      };

      const json = JSON.stringify(entry);
      const parsed = JSON.parse(json) as FrontendWorkflowEntry;

      expect(parsed).toEqual(entry);
      expect(parsed.name).toBe('json-test');
      expect(parsed.source).toBe('global');
      expect(parsed.path).toBe('/etc/workflows/json-test.yaml');
    });
  });
});
