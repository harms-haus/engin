/**
 * Tests that PhaseDescriptor and other protocol types are unified across
 * web backend, web frontend, and TUI via shared protocol-types.ts files.
 *
 * This file verifies:
 * 1. src/web/protocol-types.ts exists and exports the shared protocol value types
 * 2. src/web/types.ts re-exports those types (backward compatibility)
 * 3. src/tui/components/phase-bar.ts re-exports PhaseDescriptor from protocol-types.ts
 * 4. web/src/protocol-types.ts is a mirror copy of the backend version
 * 5. web/src/types.ts re-exports from its local protocol-types.ts
 * 6. All types are structurally identical across all sources
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
  WebServerDependencies,
  WebServerOptions,
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

  // ── Backend protocol-types.ts defines all shared types ──────────────

  describe('src/web/protocol-types.ts', () => {
    it('exports PhaseDescriptor', () => {
      const phase: BackendPhaseDescriptor = { id: 'plan', label: 'Plan', icon: '📋' };
      expect(phase.id).toBe('plan');
      expect(phase.label).toBe('Plan');
      expect(phase.icon).toBe('📋');
    });

    it('exports LogEntry', () => {
      const entry: BackendLogEntry = {
        id: 'l1',
        timestamp: '2026-06-11T00:00:00Z',
        type: 'text',
        content: 'hello',
      };
      expect(entry.type).toBe('text');
    });

    it('exports AgentWindowState', () => {
      const state: BackendAgentWindowState = {
        agentId: 'a1',
        profile: 'coder',
        active: true,
        log: [],
      };
      expect(state.agentId).toBe('a1');
    });

    it('exports SidebarInfo', () => {
      const sidebar: BackendSidebarInfo = { title: 'Test', indicator: 'blue' };
      expect(sidebar.title).toBe('Test');
    });

    it('exports WorkflowSummary', () => {
      const summary: BackendWorkflowSummary = {
        id: 'wf-1',
        workflowName: 'Test',
        status: 'running',
        sidebar: { title: 'T', indicator: 'b' },
        startedAt: '2026-06-11T00:00:00Z',
      };
      expect(summary.status).toBe('running');
    });

    it('exports ServerMessage', () => {
      const msg: BackendServerMessage = { type: 'init', workflows: [] };
      expect(msg.type).toBe('init');
    });

    it('exports ClientMessage', () => {
      const msg: BackendClientMessage = { type: 'select_workflow', workflowId: 'wf-1' };
      expect(msg.type).toBe('select_workflow');
    });
  });

  // ── Backend types.ts re-exports ─────────────────────────────────────

  describe('src/web/types.ts re-exports', () => {
    it('re-exports PhaseDescriptor (backward compat)', () => {
      const phase: TypesPhaseDescriptor = { id: 'p', label: 'P', icon: 'X' };
      expect(phase.id).toBe('p');
    });

    it('re-exports LogEntry (backward compat)', () => {
      const entry: TypesLogEntry = {
        id: 'l',
        timestamp: '2026-06-11T00:00:00Z',
        type: 'error',
        content: 'err',
      };
      expect(entry.type).toBe('error');
    });

    it('re-exports AgentWindowState (backward compat)', () => {
      const state: TypesAgentWindowState = {
        agentId: 'a',
        profile: 'scout',
        active: false,
        log: [],
      };
      expect(state.active).toBe(false);
    });

    it('re-exports SidebarInfo (backward compat)', () => {
      const sidebar: TypesSidebarInfo = { title: 'T', indicator: 'green' };
      expect(sidebar.indicator).toBe('green');
    });

    it('re-exports WorkflowSummary (backward compat)', () => {
      const summary: TypesWorkflowSummary = {
        id: 'w',
        workflowName: 'W',
        status: 'completed',
        sidebar: { title: 'T', indicator: 'g' },
        startedAt: '2026-06-11T00:00:00Z',
        completedAt: '2026-06-11T01:00:00Z',
      };
      expect(summary.status).toBe('completed');
    });

    it('re-exports ServerMessage (backward compat)', () => {
      const msg: TypesServerMessage = { type: 'init', workflows: [] };
      expect(msg.type).toBe('init');
    });

    it('re-exports ClientMessage (backward compat)', () => {
      const msg: TypesClientMessage = {
        type: 'start_workflow',
        workflowName: 'w',
        taskPrompt: 'do it',
      };
      expect(msg.type).toBe('start_workflow');
    });

    it('still has WebServerOptions (backend-only)', () => {
      const opts: WebServerOptions = { host: '0.0.0.0', port: 8080, cwd: '/tmp' };
      expect(opts.port).toBe(8080);
    });

    it('still has WebServerDependencies (backend-only)', () => {
      const deps: WebServerDependencies = {
        loadWorkflow: async (_name: string, _cwd: string) => {
          throw new Error('not implemented');
        },
        getDefaultWorkDir: (_cwd: string, _workflowName: string) => '/tmp',
        scanPastRuns: async (_cwd: string) => [],
        listWorkflows: async (_cwd: string) => [],
      };
      expect(typeof deps.listWorkflows).toBe('function');
    });
  });

  // ── TUI phase-bar.ts re-exports PhaseDescriptor ─────────────────────

  describe('src/tui/components/phase-bar.ts re-exports PhaseDescriptor', () => {
    it('exports PhaseDescriptor from protocol-types', () => {
      const phase: TuiPhaseDescriptor = { id: 'plan', label: 'Plan', icon: '📋' };
      expect(phase.id).toBe('plan');
    });
  });

  // ── Frontend protocol-types.ts mirrors backend ─────────────────────

  describe('web/src/protocol-types.ts mirror', () => {
    it('exports PhaseDescriptor', () => {
      const phase: FrontendProtocolPhaseDescriptor = { id: 'p', label: 'P', icon: '🎯' };
      expect(phase.icon).toBe('🎯');
    });

    it('exports LogEntry', () => {
      const entry: FrontendProtocolLogEntry = {
        id: 'l',
        timestamp: '2026-06-11T00:00:00Z',
        type: 'thinking',
        content: 'hmm',
      };
      expect(entry.type).toBe('thinking');
    });

    it('exports AgentWindowState', () => {
      const state: FrontendProtocolAgentWindowState = {
        agentId: 'a',
        profile: 'reviewer',
        active: true,
        log: [],
      };
      expect(state.profile).toBe('reviewer');
    });

    it('exports SidebarInfo', () => {
      const sidebar: FrontendProtocolSidebarInfo = { title: 'S', indicator: 'red' };
      expect(sidebar.indicator).toBe('red');
    });

    it('exports WorkflowSummary', () => {
      const summary: FrontendProtocolWorkflowSummary = {
        id: 'wf',
        workflowName: 'Frontend',
        status: 'failed',
        sidebar: { title: 'T', indicator: 'r' },
        startedAt: '2026-06-11T00:00:00Z',
        errorMessage: 'boom',
      };
      expect(summary.errorMessage).toBe('boom');
    });

    it('exports ServerMessage', () => {
      const msg: FrontendProtocolServerMessage = { type: 'init', workflows: [] };
      expect(msg.type).toBe('init');
    });

    it('exports ClientMessage', () => {
      const msg: FrontendProtocolClientMessage = {
        type: 'cancel_workflow',
        workflowId: 'wf-x',
      };
      expect(msg.type).toBe('cancel_workflow');
    });
  });

  // ── Frontend types.ts re-exports ────────────────────────────────────

  describe('web/src/types.ts re-exports', () => {
    it('re-exports PhaseDescriptor', () => {
      const phase: FrontendPhaseDescriptor = { id: 'f', label: 'F', icon: '🔥' };
      expect(phase.id).toBe('f');
    });

    it('re-exports LogEntry', () => {
      const entry: FrontendLogEntry = {
        id: 'fl',
        timestamp: '2026-06-11T00:00:00Z',
        type: 'decision',
        content: 'approved',
      };
      expect(entry.type).toBe('decision');
    });

    it('re-exports AgentWindowState', () => {
      const state: FrontendAgentWindowState = {
        agentId: 'fa',
        profile: 'coder',
        active: true,
        log: [],
      };
      expect(state.agentId).toBe('fa');
    });

    it('re-exports SidebarInfo', () => {
      const sidebar: FrontendSidebarInfo = { title: 'FT', indicator: 'blue' };
      expect(sidebar.title).toBe('FT');
    });

    it('re-exports WorkflowSummary', () => {
      const summary: FrontendWorkflowSummary = {
        id: 'fwf',
        workflowName: 'Frontend WF',
        status: 'running',
        sidebar: { title: 'FT', indicator: 'b' },
        startedAt: '2026-06-11T00:00:00Z',
      };
      expect(summary.workflowName).toBe('Frontend WF');
    });

    it('re-exports ServerMessage', () => {
      const msg: FrontendServerMessage = { type: 'init', workflows: [] };
      expect(msg.type).toBe('init');
    });

    it('re-exports ClientMessage', () => {
      const msg: FrontendClientMessage = {
        type: 'start_workflow',
        workflowName: 'w',
        taskPrompt: 'build it',
      };
      expect(msg.type).toBe('start_workflow');
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

      // Runtime sanity check
      const phase: BackendPhaseDescriptor = { id: 'x', label: 'X', icon: '❌' };
      expect(phase.id).toBe('x');
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
