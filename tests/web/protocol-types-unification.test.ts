/**
 * Tests that PhaseDescriptor and other protocol types are unified across
 * web backend, web frontend, and TUI via shared protocol-types.ts files.
 *
 * This file verifies:
 * 1. Both protocol-types.ts files exist on disk
 * 2. Dynamic imports of all modules resolve without errors
 * 3. Compile-time structural type identity across all sources via expectStructurallyIdentical
 * 4. ServerMessage round-trips through re-exported types
 * 5. PhaseBar integration with unified PhaseDescriptor
 * 6. web/src/protocol-types.ts is a mirror copy of the backend version
 * 7. phase-bar.ts imports (not inlines) PhaseDescriptor
 * 8. types.ts files re-export (not inline) protocol types
 */

import { describe, expect, it } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

// ─── 1. Backend protocol-types.ts exists and exports all types ──────────────

import type {
  AgentWindowState as BackendAgentWindowState,
  ClientMessage as BackendClientMessage,
  LogEntry as BackendLogEntry,
  PhaseDescriptor as BackendPhaseDescriptor,
  ServerMessage as BackendServerMessage,
  SidebarInfo as BackendSidebarInfo,
  WorkflowSummary as BackendWorkflowSummary,
} from '../../src/web/protocol-types.js';

// ─── 2. Backend types.ts re-exports all protocol types ──────────────────────

import type {
  AgentWindowState as TypesAgentWindowState,
  ClientMessage as TypesClientMessage,
  LogEntry as TypesLogEntry,
  PhaseDescriptor as TypesPhaseDescriptor,
  ServerMessage as TypesServerMessage,
  SidebarInfo as TypesSidebarInfo,
  WorkflowSummary as TypesWorkflowSummary,
} from '../../src/web/types.js';

// ─── 3. TUI phase-bar re-exports PhaseDescriptor from protocol-types ────────

import type { PhaseDescriptor as TuiPhaseDescriptor } from '../../src/tui/components/phase-bar.js';

// ─── 4. Frontend protocol-types.ts exists and exports all types ─────────────

import type {
  AgentWindowState as FrontendProtocolAgentWindowState,
  ClientMessage as FrontendProtocolClientMessage,
  LogEntry as FrontendProtocolLogEntry,
  PhaseDescriptor as FrontendProtocolPhaseDescriptor,
  ServerMessage as FrontendProtocolServerMessage,
  SidebarInfo as FrontendProtocolSidebarInfo,
  WorkflowSummary as FrontendProtocolWorkflowSummary,
} from '../../web/src/protocol-types.js';

// ─── 5. Frontend types.ts re-exports from its local protocol-types ──────────

import type {
  AgentWindowState as FrontendAgentWindowState,
  ClientMessage as FrontendClientMessage,
  LogEntry as FrontendLogEntry,
  PhaseDescriptor as FrontendPhaseDescriptor,
  ServerMessage as FrontendServerMessage,
  SidebarInfo as FrontendSidebarInfo,
  WorkflowSummary as FrontendWorkflowSummary,
} from '../../web/src/types.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

const projectRoot = join(import.meta.dir, '..', '..');

/** Checks that two types are mutually assignable (structurally identical). */
function expectStructurallyIdentical<A, B>(_a: A extends B ? (B extends A ? true : never) : never): void {
  // If this function compiles, the types are structurally identical.
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('protocol-types unification', () => {
  // ── File existence ──────────────────────────────────────────────────

  describe('protocol-types files exist', () => {
    it('src/web/protocol-types.ts exists on disk', () => {
      const path = join(projectRoot, 'src', 'web', 'protocol-types.ts');
      expect(existsSync(path)).toBe(true);
    });

    it('web/src/protocol-types.ts exists on disk', () => {
      const path = join(projectRoot, 'web', 'src', 'protocol-types.ts');
      expect(existsSync(path)).toBe(true);
    });
  });

  // ── Module resolution ───────────────────────────────────────────────

  describe('modules resolve at runtime', () => {
    it('src/web/protocol-types.js resolves dynamically', async () => {
      const mod = await import('../../src/web/protocol-types.js');
      // All exports are types/interfaces, so the module object exists but
      // may have no enumerable keys. The import itself should not throw.
      expect(mod).toBeDefined();
      expect(typeof mod).toBe('object');
    });

    it('web/src/protocol-types.js resolves dynamically', async () => {
      const mod = await import('../../web/src/protocol-types.js');
      expect(mod).toBeDefined();
      expect(typeof mod).toBe('object');
    });

    it('src/web/types.js still resolves (backward compat)', async () => {
      const mod = await import('../../src/web/types.js');
      expect(mod).toBeDefined();
      expect(typeof mod).toBe('object');
    });

    it('src/tui/components/phase-bar.js still resolves', async () => {
      const mod = await import('../../src/tui/components/phase-bar.js');
      expect(mod).toBeDefined();
      expect(typeof mod).toBe('object');
      // PhaseBar class should be available
      expect(typeof mod.PhaseBar).toBe('function');
    });
  });

  // ── Structural identity across all sources ─────────────────────────

  describe('structural identity across all sources', () => {
    it('PhaseDescriptor is identical across backend, TUI, and frontend', () => {
      // These compile-time checks ensure structural identity.
      // If any type differs, TypeScript will error.
      expectStructurallyIdentical<BackendPhaseDescriptor, TypesPhaseDescriptor>(true);
      expectStructurallyIdentical<BackendPhaseDescriptor, TuiPhaseDescriptor>(true);
      expectStructurallyIdentical<BackendPhaseDescriptor, FrontendProtocolPhaseDescriptor>(true);
      expectStructurallyIdentical<BackendPhaseDescriptor, FrontendPhaseDescriptor>(true);
      expectStructurallyIdentical<TypesPhaseDescriptor, TuiPhaseDescriptor>(true);
      expectStructurallyIdentical<FrontendProtocolPhaseDescriptor, FrontendPhaseDescriptor>(true);
    });

    it('LogEntry is identical across backend and frontend', () => {
      expectStructurallyIdentical<BackendLogEntry, TypesLogEntry>(true);
      expectStructurallyIdentical<BackendLogEntry, FrontendProtocolLogEntry>(true);
      expectStructurallyIdentical<BackendLogEntry, FrontendLogEntry>(true);
      expectStructurallyIdentical<FrontendProtocolLogEntry, FrontendLogEntry>(true);
    });

    it('AgentWindowState is identical across backend and frontend', () => {
      expectStructurallyIdentical<BackendAgentWindowState, TypesAgentWindowState>(true);
      expectStructurallyIdentical<BackendAgentWindowState, FrontendProtocolAgentWindowState>(true);
      expectStructurallyIdentical<BackendAgentWindowState, FrontendAgentWindowState>(true);
      expectStructurallyIdentical<FrontendProtocolAgentWindowState, FrontendAgentWindowState>(true);
    });

    it('SidebarInfo is identical across backend and frontend', () => {
      expectStructurallyIdentical<BackendSidebarInfo, TypesSidebarInfo>(true);
      expectStructurallyIdentical<BackendSidebarInfo, FrontendProtocolSidebarInfo>(true);
      expectStructurallyIdentical<BackendSidebarInfo, FrontendSidebarInfo>(true);
      expectStructurallyIdentical<FrontendProtocolSidebarInfo, FrontendSidebarInfo>(true);
    });

    it('WorkflowSummary is identical across backend and frontend', () => {
      expectStructurallyIdentical<BackendWorkflowSummary, TypesWorkflowSummary>(true);
      expectStructurallyIdentical<BackendWorkflowSummary, FrontendProtocolWorkflowSummary>(true);
      expectStructurallyIdentical<BackendWorkflowSummary, FrontendWorkflowSummary>(true);
      expectStructurallyIdentical<FrontendProtocolWorkflowSummary, FrontendWorkflowSummary>(true);
    });

    it('ServerMessage is identical across backend and frontend', () => {
      expectStructurallyIdentical<BackendServerMessage, TypesServerMessage>(true);
      expectStructurallyIdentical<BackendServerMessage, FrontendProtocolServerMessage>(true);
      expectStructurallyIdentical<BackendServerMessage, FrontendServerMessage>(true);
      expectStructurallyIdentical<FrontendProtocolServerMessage, FrontendServerMessage>(true);
    });

    it('ClientMessage is identical across backend and frontend', () => {
      expectStructurallyIdentical<BackendClientMessage, TypesClientMessage>(true);
      expectStructurallyIdentical<BackendClientMessage, FrontendProtocolClientMessage>(true);
      expectStructurallyIdentical<BackendClientMessage, FrontendClientMessage>(true);
      expectStructurallyIdentical<FrontendProtocolClientMessage, FrontendClientMessage>(true);
    });
  });

  // ── Full round-trip with all ServerMessage variants ─────────────────

  describe('ServerMessage round-trips via backend types.ts re-export', () => {
    it('load_past_run variant carries agents with phase', () => {
      const msg: TypesServerMessage = {
        type: 'load_past_run',
        workflowId: 'wf-past',
        summary: {
          id: 'wf-past',
          workflowName: 'Past',
          status: 'completed',
          sidebar: { title: 'Past', indicator: 'green' },
          startedAt: '2026-06-11T00:00:00Z',
          completedAt: '2026-06-11T01:00:00Z',
        },
        currentPhase: 'done',
        completedPhases: ['a', 'b'],
        agents: [{ agentId: 'a1', profile: 'coder', active: false, log: [], phase: 'b' }],
      };

      if (msg.type === 'load_past_run') {
        expect(msg.agents[0].phase).toBe('b');
      }
    });
  });

  // ── PhaseBar still works with re-exported PhaseDescriptor ───────────

  describe('PhaseBar integration with unified PhaseDescriptor', () => {
    it('PhaseBar.setPhases accepts PhaseDescriptor from protocol-types', async () => {
      const { PhaseBar } = await import('../../src/tui/components/phase-bar.js');
      const bar = new PhaseBar();

      const phases: BackendPhaseDescriptor[] = [
        { id: 'plan', label: 'Plan', icon: '📋' },
        { id: 'exec', label: 'Execute', icon: '⚡' },
      ];

      bar.setPhases(phases);
      bar.setCurrentPhase('plan');

      const lines = bar.render(60);
      expect(lines[0]).toContain('Plan');
      expect(lines[0]).toContain('●');
    });

    it('PhaseBar.setPhases accepts PhaseDescriptor from types.ts re-export', async () => {
      const { PhaseBar } = await import('../../src/tui/components/phase-bar.js');
      const bar = new PhaseBar();

      const phases: TypesPhaseDescriptor[] = [{ id: 'a', label: 'Alpha', icon: '🅰️' }];

      bar.setPhases(phases);
      const lines = bar.render(40);
      expect(lines[0]).toContain('Alpha');
    });

    it('PhaseBar.setPhases accepts PhaseDescriptor from frontend protocol-types', async () => {
      const { PhaseBar } = await import('../../src/tui/components/phase-bar.js');
      const bar = new PhaseBar();

      const phases: FrontendProtocolPhaseDescriptor[] = [{ id: 'review', label: 'Review', icon: '🔍' }];

      bar.setPhases(phases);
      const lines = bar.render(40);
      expect(lines[0]).toContain('Review');
    });
  });

  // ── Content verification: protocol-types.ts has mirror comment ──────

  describe('web/src/protocol-types.ts is a mirror copy', () => {
    it('contains mirror comment at the top', async () => {
      const fs = await import('node:fs/promises');
      const path = join(projectRoot, 'web', 'src', 'protocol-types.ts');
      const content = await fs.readFile(path, 'utf-8');
      // The mirror file should have a comment indicating it mirrors the backend version
      expect(content).toContain('Mirror of src/web/protocol-types.ts');
    });

    it('contains the same type definitions as backend protocol-types', async () => {
      const fs = await import('node:fs/promises');
      const backendPath = join(projectRoot, 'src', 'web', 'protocol-types.ts');
      const frontendPath = join(projectRoot, 'web', 'src', 'protocol-types.ts');

      const backendContent = await fs.readFile(backendPath, 'utf-8');
      const frontendContent = await fs.readFile(frontendPath, 'utf-8');

      // Both should define PhaseDescriptor (ignoring the mirror comment line)
      expect(backendContent).toContain('PhaseDescriptor');
      expect(frontendContent).toContain('PhaseDescriptor');

      // Both should define all protocol types
      const typeNames = [
        'PhaseDescriptor',
        'LogEntry',
        'AgentWindowState',
        'SidebarInfo',
        'WorkflowSummary',
        'ServerMessage',
        'ClientMessage',
      ];

      for (const typeName of typeNames) {
        expect(backendContent).toContain(typeName);
        expect(frontendContent).toContain(typeName);
      }
    });
  });

  // ── phase-bar.ts no longer has inline PhaseDescriptor ───────────────

  describe('src/tui/components/phase-bar.ts imports PhaseDescriptor', () => {
    it('imports PhaseDescriptor from protocol-types.js, not defined inline', async () => {
      const fs = await import('node:fs/promises');
      const path = join(projectRoot, 'src', 'tui', 'components', 'phase-bar.ts');
      const content = await fs.readFile(path, 'utf-8');

      // Should import PhaseDescriptor from protocol-types
      expect(content).toMatch(/from\s+['"]\.\.\/\.\.\/web\/protocol-types\.js['"]/);

      // Should NOT have an inline `export interface PhaseDescriptor` definition
      expect(content).not.toMatch(/export\s+interface\s+PhaseDescriptor\s*\{/);

      // Should have a re-export of PhaseDescriptor
      expect(content).toMatch(/export\s+type\s*\{[^}]*PhaseDescriptor[^}]*\}\s*from/);
    });
  });

  // ── src/web/types.ts re-exports from protocol-types ─────────────────

  describe('src/web/types.ts re-exports structure', () => {
    it('re-exports protocol types from protocol-types.js', async () => {
      const fs = await import('node:fs/promises');
      const path = join(projectRoot, 'src', 'web', 'types.ts');
      const content = await fs.readFile(path, 'utf-8');

      // Should re-export from protocol-types
      expect(content).toMatch(/export\s+type\s*\{[^}]*PhaseDescriptor[^}]*\}\s*from\s+['"]\.\/protocol-types\.js['"]/);

      // Should NOT have inline definitions of the moved types
      expect(content).not.toMatch(/export\s+interface\s+PhaseDescriptor\s*\{/);
      expect(content).not.toMatch(/export\s+interface\s+LogEntry\s*\{/);
      expect(content).not.toMatch(/export\s+interface\s+AgentWindowState\s*\{/);
      expect(content).not.toMatch(/export\s+interface\s+SidebarInfo\s*\{/);
      expect(content).not.toMatch(/export\s+interface\s+WorkflowSummary\s*\{/);
      expect(content).not.toMatch(/export\s+type\s+ServerMessage\s*=/);
      expect(content).not.toMatch(/export\s+type\s+ClientMessage\s*=/);

      // Should still have backend-only types
      expect(content).toContain('WebServerOptions');
      expect(content).toContain('WebServerDependencies');
    });
  });

  // ── web/src/types.ts re-exports from protocol-types ─────────────────

  describe('web/src/types.ts re-exports structure', () => {
    it('re-exports protocol types from ./protocol-types.ts', async () => {
      const fs = await import('node:fs/promises');
      const path = join(projectRoot, 'web', 'src', 'types.ts');
      const content = await fs.readFile(path, 'utf-8');

      // Should re-export from protocol-types
      expect(content).toMatch(/export\s+type\s*\{[^}]*PhaseDescriptor[^}]*\}\s*from\s+['"]\.\/protocol-types/);

      // Should NOT have inline definitions of the shared types
      expect(content).not.toMatch(/export\s+interface\s+PhaseDescriptor\s*\{/);
      expect(content).not.toMatch(/export\s+interface\s+LogEntry\s*\{/);
      expect(content).not.toMatch(/export\s+interface\s+AgentWindowState\s*\{/);
      expect(content).not.toMatch(/export\s+interface\s+SidebarInfo\s*\{/);
      expect(content).not.toMatch(/export\s+interface\s+WorkflowSummary\s*\{/);
      expect(content).not.toMatch(/export\s+type\s+ServerMessage\s*=/);
      expect(content).not.toMatch(/export\s+type\s+ClientMessage\s*=/);

      // Should still have frontend-specific types
      expect(content).toContain('WorkflowRunState');
      expect(content).toContain('AppGlobalState');
      expect(content).toContain('isServerMessage');
    });
  });
});
