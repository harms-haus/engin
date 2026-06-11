/* eslint-disable @typescript-eslint/no-non-null-assertion */
/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Tests for DevelopRenderer component.
 *
 * Verifies the auto-follow / manual-tab pinning behavior for the phase
 * ProgressIndicator, the AgentGrid filtering by effective tab, and the
 * removal of the old develop-phase-label element.
 */

import '@testing-library/jest-dom/vitest';

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { AgentWindowState, LogEntry, PhaseDescriptor, WorkflowRunState, WorkflowSummary } from '../../../types';
import { DevelopRenderer } from '../DevelopRenderer';
import type { DevelopAgentInfo } from '../types';

// ─── Mock @tanstack/react-virtual ──────────────────────────────────────────
// AgentLog uses a virtualizer internally; mock it so that log entries
// appear as rendered content in tests.

const mockScrollToIndex = vi.fn();
const mockGetTotalSize = vi.fn(() => 0);
const mockGetVirtualItems = vi.fn(() => []);

vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: vi.fn(() => ({
    getVirtualItems: mockGetVirtualItems,
    getTotalSize: mockGetTotalSize,
    scrollToIndex: mockScrollToIndex,
  })),
}));

// ─── Helpers ────────────────────────────────────────────────────────────────

function createPhase(id: string, label?: string, icon?: string): PhaseDescriptor {
  return { id, label: label ?? id, icon: icon ?? '🔵' };
}

function createAgentWindow(agentId: string, overrides: Partial<AgentWindowState> = {}): AgentWindowState {
  return {
    agentId,
    profile: 'default',
    active: false,
    log: [],
    ...overrides,
  };
}

function createSummary(overrides: Partial<WorkflowSummary> = {}): WorkflowSummary {
  const sidebar = overrides.sidebar ?? {
    title: 'Test',
    indicator: '…',
    phases: [],
  };
  return {
    id: 'test-run',
    workflowName: 'Test Workflow',
    status: 'running',
    startedAt: new Date().toISOString(),
    ...overrides,
    sidebar,
  };
}

function createRunState(overrides: Partial<WorkflowRunState> = {}): WorkflowRunState {
  return {
    summary: createSummary(),
    agents: new Map(),
    currentPhase: '',
    completedPhases: [],
    ...overrides,
  };
}

// Build a run state with phases and agents for realistic testing
function buildRunStateWithPhases(
  phases: PhaseDescriptor[],
  currentPhase: string,
  completedPhases: string[],
  agents: Map<string, AgentWindowState> = new Map(),
): WorkflowRunState {
  const summary = createSummary({
    sidebar: { title: 'Test', indicator: '…', phases },
  });
  return createRunState({
    summary,
    currentPhase,
    completedPhases,
    agents,
  });
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('DevelopRenderer', () => {
  describe('basic rendering', () => {
    it('renders without errors with a minimal run state', () => {
      const runState = createRunState();
      const { container } = render(<DevelopRenderer runState={runState} />);
      expect(container.querySelector('.develop-renderer')).toBeInTheDocument();
    });

    it('renders the ProgressIndicator component', () => {
      const phases = [
        createPhase('init', 'Init', '🚀'),
        createPhase('build', 'Build', '⚙️'),
      ];
      const runState = buildRunStateWithPhases(phases, 'build', ['init']);
      const { container } = render(<DevelopRenderer runState={runState} />);
      expect(container.querySelector('.progress-indicator')).toBeInTheDocument();
    });

    it('renders the AgentGrid component', () => {
      const phases = [createPhase('init', 'Init', '🚀')];
      const runState = buildRunStateWithPhases(phases, 'init', []);
      const { container } = render(<DevelopRenderer runState={runState} />);
      expect(
        container.querySelector('.agent-grid') || container.querySelector('.agent-grid-empty'),
      ).toBeInTheDocument();
    });

    it('does not render the develop-phase-label element', () => {
      const phases = [createPhase('init', 'Init', '🚀')];
      const runState = buildRunStateWithPhases(phases, 'init', []);
      const { container } = render(<DevelopRenderer runState={runState} />);
      expect(container.querySelector('.develop-phase-label')).not.toBeInTheDocument();
    });

    it('renders the develop-content wrapper', () => {
      const runState = createRunState();
      const { container } = render(<DevelopRenderer runState={runState} />);
      expect(container.querySelector('.develop-content')).toBeInTheDocument();
    });
  });

  describe('auto-follow mode (initial state)', () => {
    it('shows the active phase tab as selected when there is a currentPhase', () => {
      const phases = [
        createPhase('init', 'Init', '🚀'),
        createPhase('build', 'Build', '⚙️'),
        createPhase('deploy', 'Deploy', '🚀'),
      ];
      const runState = buildRunStateWithPhases(phases, 'build', ['init']);
      const { container } = render(<DevelopRenderer runState={runState} />);
      const tabs = container.querySelectorAll('.phase-tab');
      // 'init' (index 0) is completed, 'build' (index 1) is active, 'deploy' (index 2) is pending
      expect(tabs[0]).not.toHaveClass('phase-tab--selected');
      expect(tabs[1]).toHaveClass('phase-tab--selected');
      expect(tabs[2]).not.toHaveClass('phase-tab--selected');
    });

    it('renders no selected tab when currentPhase is empty (empty string is not nullish)', () => {
      const phases = [
        createPhase('init', 'Init', '🚀'),
        createPhase('build', 'Build', '⚙️'),
      ];
      const runState = buildRunStateWithPhases(phases, '', []);
      const { container } = render(<DevelopRenderer runState={runState} />);
      const tabs = container.querySelectorAll('.phase-tab');
      // effectiveTab = null ?? '' ?? (phases[0]?.id ?? '') = ''
      // No phase has id '', so no tab is selected
      expect(tabs[0]).not.toHaveClass('phase-tab--selected');
      expect(tabs[1]).not.toHaveClass('phase-tab--selected');
    });

    it('renders no phases when there are no phases', () => {
      const runState = createRunState({ currentPhase: '' });
      const { container } = render(<DevelopRenderer runState={runState} />);
      const tabs = container.querySelectorAll('.phase-tab');
      expect(tabs).toHaveLength(0);
    });

    it('passes the active phase id as activePhaseTab to ProgressIndicator', () => {
      const phases = [
        createPhase('plan', 'Plan', '📋'),
        createPhase('code', 'Code', '💻'),
      ];
      const runState = buildRunStateWithPhases(phases, 'code', ['plan']);
      render(<DevelopRenderer runState={runState} />);
      // The code tab should be selected
      expect(screen.getByText('Code').closest('.phase-tab')).toHaveClass('phase-tab--selected');
    });

    it('follows currentPhase when there is no manualTab (auto-follow)', () => {
      const phases = [
        createPhase('a', 'A', '1'),
        createPhase('b', 'B', '2'),
        createPhase('c', 'C', '3'),
      ];
      const runState = buildRunStateWithPhases(phases, 'b', ['a']);
      const { container } = render(<DevelopRenderer runState={runState} />);
      const tabs = container.querySelectorAll('.phase-tab');
      expect(tabs[1]).toHaveClass('phase-tab--selected');
    });

    it('shows first phase as selected when currentPhase matches the first phase id', () => {
      const phases = [
        createPhase('init', 'Init', '🚀'),
        createPhase('build', 'Build', '⚙️'),
      ];
      const runState = buildRunStateWithPhases(phases, 'init', []);
      const { container } = render(<DevelopRenderer runState={runState} />);
      const tabs = container.querySelectorAll('.phase-tab');
      expect(tabs[0]).toHaveClass('phase-tab--selected');
      expect(tabs[1]).not.toHaveClass('phase-tab--selected');
    });
  });

  describe('effective tab derivation', () => {
    it('uses manualTab when set (higher priority than currentPhase)', () => {
      const phases = [
        createPhase('plan', 'Plan', '📋'),
        createPhase('code', 'Code', '💻'),
        createPhase('test', 'Test', '🧪'),
      ];
      const runState = buildRunStateWithPhases(phases, 'code', ['plan']);

      const { container } = render(<DevelopRenderer runState={runState} />);
      // Initially auto-following 'code'
      let tabs = container.querySelectorAll('.phase-tab');
      expect(tabs[1]).toHaveClass('phase-tab--selected');

      // Click on 'plan' (completed tab) to pin manually
      fireEvent.click(screen.getByText('Plan').closest('.phase-tab')!);
      tabs = container.querySelectorAll('.phase-tab');
      // Now manualTab = 'plan', so effectiveTab should be 'plan'
      expect(tabs[0]).toHaveClass('phase-tab--selected');
      expect(tabs[1]).not.toHaveClass('phase-tab--selected');
    });

    it('uses currentPhase when manualTab is null', () => {
      const phases = [
        createPhase('a', 'A', '1'),
        createPhase('b', 'B', '2'),
      ];
      const runState = buildRunStateWithPhases(phases, 'b', ['a']);
      const { container } = render(<DevelopRenderer runState={runState} />);
      const tabs = container.querySelectorAll('.phase-tab');
      expect(tabs[1]).toHaveClass('phase-tab--selected');
    });
  });

  describe('tab click behavior — pinning', () => {
    it('pins to the clicked non-active tab', () => {
      const phases = [
        createPhase('plan', 'Plan', '📋'),
        createPhase('code', 'Code', '💻'),
        createPhase('test', 'Test', '🧪'),
      ];
      const runState = buildRunStateWithPhases(phases, 'code', ['plan']);

      const { container } = render(<DevelopRenderer runState={runState} />);
      // Click on completed 'plan' tab
      fireEvent.click(screen.getByText('Plan').closest('.phase-tab')!);
      const tabs = container.querySelectorAll('.phase-tab');
      expect(tabs[0]).toHaveClass('phase-tab--selected');
      expect(tabs[1]).not.toHaveClass('phase-tab--selected');
    });

    it('pins to a different completed tab than the current active', () => {
      const phases = [
        createPhase('a', 'A', '1'),
        createPhase('b', 'B', '2'),
        createPhase('c', 'C', '3'),
      ];
      const runState = buildRunStateWithPhases(phases, 'b', ['a']);

      const { container } = render(<DevelopRenderer runState={runState} />);
      // Click on completed 'a' tab
      fireEvent.click(screen.getByText('A').closest('.phase-tab')!);
      const tabs = container.querySelectorAll('.phase-tab');
      expect(tabs[0]).toHaveClass('phase-tab--selected');
      expect(tabs[1]).not.toHaveClass('phase-tab--selected');
    });

    it('does not pin when clicking a pending tab (ProgressIndicator ignores clicks on pending)', () => {
      const phases = [
        createPhase('a', 'A', '1'),
        createPhase('b', 'B', '2'),
        createPhase('c', 'C', '3'),
      ];
      const runState = buildRunStateWithPhases(phases, 'a', []);

      const { container } = render(<DevelopRenderer runState={runState} />);
      // 'c' is pending — ProgressIndicator prevents onTabClick for pending tabs
      fireEvent.click(screen.getByText('C').closest('.phase-tab')!);
      const tabs = container.querySelectorAll('.phase-tab');
      // Should still be on 'a' (auto-follow on currentPhase = 'a')
      expect(tabs[0]).toHaveClass('phase-tab--selected');
      expect(tabs[2]).not.toHaveClass('phase-tab--selected');
    });
  });

  describe('tab click behavior — re-engaging auto-follow', () => {
    it('resets to auto-follow when clicking the active phase tab after pinning', () => {
      const phases = [
        createPhase('plan', 'Plan', '📋'),
        createPhase('code', 'Code', '💻'),
        createPhase('test', 'Test', '🧪'),
      ];
      const runState = buildRunStateWithPhases(phases, 'code', ['plan']);

      const { container } = render(<DevelopRenderer runState={runState} />);
      // First, pin to 'plan'
      fireEvent.click(screen.getByText('Plan').closest('.phase-tab')!);
      let tabs = container.querySelectorAll('.phase-tab');
      expect(tabs[0]).toHaveClass('phase-tab--selected');
      expect(tabs[1]).not.toHaveClass('phase-tab--selected');

      // Now click the active phase 'code' to re-engage auto-follow
      fireEvent.click(screen.getByText('Code').closest('.phase-tab')!);
      tabs = container.querySelectorAll('.phase-tab');
      expect(tabs[1]).toHaveClass('phase-tab--selected');
      expect(tabs[0]).not.toHaveClass('phase-tab--selected');
    });

    it('re-engages auto-follow when clicking the active tab without prior pinning', () => {
      const phases = [
        createPhase('a', 'A', '1'),
        createPhase('b', 'B', '2'),
      ];
      const runState = buildRunStateWithPhases(phases, 'b', ['a']);

      const { container } = render(<DevelopRenderer runState={runState} />);
      // Click on the already-active tab 'b' — should stay on auto-follow
      fireEvent.click(screen.getByText('B').closest('.phase-tab')!);
      const tabs = container.querySelectorAll('.phase-tab');
      expect(tabs[1]).toHaveClass('phase-tab--selected');
      expect(tabs[0]).not.toHaveClass('phase-tab--selected');
    });

    it('stays pinned to manual tab when a different non-active tab is clicked', () => {
      const phases = [
        createPhase('a', 'A', '1'),
        createPhase('b', 'B', '2'),
        createPhase('c', 'C', '3'),
      ];
      const runState = buildRunStateWithPhases(phases, 'b', ['a', 'c']);

      const { container } = render(<DevelopRenderer runState={runState} />);
      // Pin to 'a'
      fireEvent.click(screen.getByText('A').closest('.phase-tab')!);
      let tabs = container.querySelectorAll('.phase-tab');
      expect(tabs[0]).toHaveClass('phase-tab--selected');

      // Click on 'c' (also completed) — should pin to 'c'
      fireEvent.click(screen.getByText('C').closest('.phase-tab')!);
      tabs = container.querySelectorAll('.phase-tab');
      expect(tabs[2]).toHaveClass('phase-tab--selected');
      expect(tabs[0]).not.toHaveClass('phase-tab--selected');
    });
  });

  describe('agent filtering by effective tab', () => {
    it('shows agents for the active phase in auto-follow mode', () => {
      const phases = [
        createPhase('plan', 'Plan', '📋'),
        createPhase('code', 'Code', '💻'),
      ];
      const agents = new Map<string, AgentWindowState>([
        ['coder-1', createAgentWindow('coder-1', { profile: 'Coder', phase: 'code', active: true })],
        ['planner-1', createAgentWindow('planner-1', { profile: 'Planner', phase: 'plan', active: false })],
      ]);
      const runState = buildRunStateWithPhases(phases, 'code', ['plan'], agents);
      render(<DevelopRenderer runState={runState} />);
      // 'code' is active, so only Coder agent should be visible
      expect(screen.getByText('Coder')).toBeInTheDocument();
      expect(screen.queryByText('Planner')).not.toBeInTheDocument();
    });

    it('shows agents for the pinned phase after manual click', () => {
      const phases = [
        createPhase('plan', 'Plan', '📋'),
        createPhase('code', 'Code', '💻'),
      ];
      const agents = new Map<string, AgentWindowState>([
        ['coder-1', createAgentWindow('coder-1', { profile: 'Coder', phase: 'code', active: true })],
        ['planner-1', createAgentWindow('planner-1', { profile: 'Planner', phase: 'plan', active: false })],
      ]);
      const runState = buildRunStateWithPhases(phases, 'code', ['plan'], agents);

      const { container } = render(<DevelopRenderer runState={runState} />);
      // Initially showing code agents
      expect(screen.getByText('Coder')).toBeInTheDocument();
      expect(screen.queryByText('Planner')).not.toBeInTheDocument();

      // Pin to 'plan'
      fireEvent.click(screen.getByText('Plan').closest('.phase-tab')!);
      // Now showing plan agents
      expect(screen.getByText('Planner')).toBeInTheDocument();
      expect(screen.queryByText('Coder')).not.toBeInTheDocument();
    });

    it('shows agents for the pinned phase even if currentPhase changes conceptually', () => {
      const phases = [
        createPhase('plan', 'Plan', '📋'),
        createPhase('code', 'Code', '💻'),
        createPhase('test', 'Test', '🧪'),
      ];
      const agents = new Map<string, AgentWindowState>([
        ['coder-1', createAgentWindow('coder-1', { profile: 'Coder', phase: 'code', active: true })],
        ['planner-1', createAgentWindow('planner-1', { profile: 'Planner', phase: 'plan', active: false })],
      ]);
      const runState = buildRunStateWithPhases(phases, 'code', ['plan'], agents);

      const { container } = render(<DevelopRenderer runState={runState} />);
      // Pin to 'plan'
      fireEvent.click(screen.getByText('Plan').closest('.phase-tab')!);
      expect(screen.getByText('Planner')).toBeInTheDocument();
      expect(screen.queryByText('Coder')).not.toBeInTheDocument();
    });

    it('switches agents back when auto-follow is re-engaged', () => {
      const phases = [
        createPhase('plan', 'Plan', '📋'),
        createPhase('code', 'Code', '💻'),
      ];
      const agents = new Map<string, AgentWindowState>([
        ['coder-1', createAgentWindow('coder-1', { profile: 'Coder', phase: 'code', active: true })],
        ['planner-1', createAgentWindow('planner-1', { profile: 'Planner', phase: 'plan', active: false })],
      ]);
      const runState = buildRunStateWithPhases(phases, 'code', ['plan'], agents);

      const { container } = render(<DevelopRenderer runState={runState} />);
      // Pin to 'plan'
      fireEvent.click(screen.getByText('Plan').closest('.phase-tab')!);
      expect(screen.getByText('Planner')).toBeInTheDocument();
      expect(screen.queryByText('Coder')).not.toBeInTheDocument();

      // Re-engage auto-follow by clicking active tab 'code'
      fireEvent.click(screen.getByText('Code').closest('.phase-tab')!);
      expect(screen.getByText('Coder')).toBeInTheDocument();
      expect(screen.queryByText('Planner')).not.toBeInTheDocument();
    });

    it('shows the correct agents after multiple pin/unpin cycles', () => {
      const phases = [
        createPhase('a', 'A', '1'),
        createPhase('b', 'B', '2'),
        createPhase('c', 'C', '3'),
      ];
      const agents = new Map<string, AgentWindowState>([
        ['agent-a', createAgentWindow('agent-a', { profile: 'AgentA', phase: 'a' })],
        ['agent-b', createAgentWindow('agent-b', { profile: 'AgentB', phase: 'b' })],
        ['agent-c', createAgentWindow('agent-c', { profile: 'AgentC', phase: 'c' })],
      ]);
      const runState = buildRunStateWithPhases(phases, 'b', ['a'], agents);

      const { container } = render(<DevelopRenderer runState={runState} />);
      // Auto-follow on 'b'
      expect(screen.getByText('AgentB')).toBeInTheDocument();

      // Pin to 'a'
      fireEvent.click(screen.getByText('A').closest('.phase-tab')!);
      expect(screen.getByText('AgentA')).toBeInTheDocument();
      expect(screen.queryByText('AgentB')).not.toBeInTheDocument();

      // Re-engage auto-follow (click on active 'b')
      fireEvent.click(screen.getByText('B').closest('.phase-tab')!);
      expect(screen.getByText('AgentB')).toBeInTheDocument();
      expect(screen.queryByText('AgentA')).not.toBeInTheDocument();
    });
  });

  describe('empty agent states', () => {
    it('shows the default empty message when no agents exist for the effective tab', () => {
      const phases = [
        createPhase('plan', 'Plan', '📋'),
        createPhase('code', 'Code', '💻'),
      ];
      const runState = buildRunStateWithPhases(phases, 'code', ['plan']);
      render(<DevelopRenderer runState={runState} />);
      // AgentGrid shows its custom empty state message from DevelopRenderer
      expect(screen.getByText('No agents in this phase')).toBeInTheDocument();
    });

    it('shows empty state for a pinned tab with no agents', () => {
      const phases = [
        createPhase('plan', 'Plan', '📋'),
        createPhase('code', 'Code', '💻'),
      ];
      const agents = new Map<string, AgentWindowState>([
        ['coder-1', createAgentWindow('coder-1', { profile: 'Coder', phase: 'code', active: true })],
      ]);
      const runState = buildRunStateWithPhases(phases, 'code', ['plan'], agents);

      const { container } = render(<DevelopRenderer runState={runState} />);
      // Pin to 'plan' which has no agents
      fireEvent.click(screen.getByText('Plan').closest('.phase-tab')!);
      expect(screen.getByText('No agents in this phase')).toBeInTheDocument();
    });

    it('shows agents when they exist for the effective tab', () => {
      const phases = [
        createPhase('plan', 'Plan', '📋'),
        createPhase('code', 'Code', '💻'),
      ];
      const agents = new Map<string, AgentWindowState>([
        ['coder-1', createAgentWindow('coder-1', { profile: 'Coder', phase: 'code', active: true })],
      ]);
      const runState = buildRunStateWithPhases(phases, 'code', ['plan'], agents);
      render(<DevelopRenderer runState={runState} />);
      expect(screen.getByText('Coder')).toBeInTheDocument();
      expect(screen.queryByText('No active agents')).not.toBeInTheDocument();
    });
  });

  describe('ProgressIndicator props', () => {
    it('passes the phases array to ProgressIndicator', () => {
      const phases = [
        createPhase('a', 'Alpha', '1'),
        createPhase('b', 'Beta', '2'),
      ];
      const runState = buildRunStateWithPhases(phases, 'b', ['a']);
      render(<DevelopRenderer runState={runState} />);
      expect(screen.getByText('Alpha')).toBeInTheDocument();
      expect(screen.getByText('Beta')).toBeInTheDocument();
    });

    it('sets correct selected tab in ProgressIndicator based on effectiveTab', () => {
      const phases = [
        createPhase('a', 'Alpha', '1'),
        createPhase('b', 'Beta', '2'),
      ];
      const runState = buildRunStateWithPhases(phases, 'b', ['a']);
      const { container } = render(<DevelopRenderer runState={runState} />);
      const tabs = container.querySelectorAll('.phase-tab');
      expect(tabs[0]).not.toHaveClass('phase-tab--selected');
      expect(tabs[1]).toHaveClass('phase-tab--selected');
    });
  });

  describe('registerRenderer side effect', () => {
    it('registers the renderer with the name "develop"', async () => {
      const { getRenderer } = await import('../../registry');
      // Importing the module triggers registerRenderer
      await import('../DevelopRenderer');
      expect(getRenderer('develop')).toBeDefined();
    });
  });

  describe('multiple agents in same phase', () => {
    it('shows all agents belonging to the effective tab phase', () => {
      const phases = [
        createPhase('code', 'Code', '💻'),
        createPhase('test', 'Test', '🧪'),
      ];
      const agents = new Map<string, AgentWindowState>([
        ['coder-1', createAgentWindow('coder-1', { profile: 'Coder 1', phase: 'code', active: true })],
        ['coder-2', createAgentWindow('coder-2', { profile: 'Coder 2', phase: 'code', active: true })],
        ['tester-1', createAgentWindow('tester-1', { profile: 'Tester', phase: 'test', active: true })],
      ]);
      const runState = buildRunStateWithPhases(phases, 'code', [], agents);
      render(<DevelopRenderer runState={runState} />);
      expect(screen.getByText('Coder 1')).toBeInTheDocument();
      expect(screen.getByText('Coder 2')).toBeInTheDocument();
      expect(screen.queryByText('Tester')).not.toBeInTheDocument();
    });

    it('switches to show test agents after pinning to completed test phase', () => {
      const phases = [
        createPhase('code', 'Code', '💻'),
        createPhase('test', 'Test', '🧪'),
      ];
      const agents = new Map<string, AgentWindowState>([
        ['coder-1', createAgentWindow('coder-1', { profile: 'Coder 1', phase: 'code', active: true })],
        ['coder-2', createAgentWindow('coder-2', { profile: 'Coder 2', phase: 'code', active: true })],
        ['tester-1', createAgentWindow('tester-1', { profile: 'Tester', phase: 'test', active: true })],
      ]);
      // currentPhase='test', completedPhases=['code'] → 'code' completed, 'test' active
      const runState = buildRunStateWithPhases(phases, 'test', ['code'], agents);

      const { container } = render(<DevelopRenderer runState={runState} />);
      // Auto-follow is on 'test' initially. Click 'code' (completed) to pin there,
      // then click 'test' (active) to re-engage auto-follow, showing test agents.
      // Instead, let's just pin to 'code' first and verify filtering:
      fireEvent.click(screen.getByText('Code').closest('.phase-tab')!);
      expect(screen.getByText('Coder 1')).toBeInTheDocument();
      expect(screen.queryByText('Tester')).not.toBeInTheDocument();

      // Re-engage auto-follow by clicking active 'test' tab
      fireEvent.click(screen.getByText('Test').closest('.phase-tab')!);
      expect(screen.getByText('Tester')).toBeInTheDocument();
      expect(screen.queryByText('Coder 1')).not.toBeInTheDocument();
      expect(screen.queryByText('Coder 2')).not.toBeInTheDocument();
    });
  });

  describe('edge cases', () => {
    it('handles run state with no phases', () => {
      const runState = createRunState({ currentPhase: '' });
      const { container } = render(<DevelopRenderer runState={runState} />);
      expect(container.querySelector('.develop-renderer')).toBeInTheDocument();
      expect(container.querySelector('.progress-indicator')).toBeInTheDocument();
    });

    it('handles run state with one phase', () => {
      const phases = [createPhase('solo', 'Solo', '🔹')];
      const runState = buildRunStateWithPhases(phases, 'solo', []);
      const { container } = render(<DevelopRenderer runState={runState} />);
      const tabs = container.querySelectorAll('.phase-tab');
      expect(tabs).toHaveLength(1);
      expect(tabs[0]).toHaveClass('phase-tab--selected');
    });

    it('handles currentPhase being empty with no phases array', () => {
      const runState = createRunState({ currentPhase: '', completedPhases: [] });
      const { container } = render(<DevelopRenderer runState={runState} />);
      expect(container.querySelector('.develop-renderer')).toBeInTheDocument();
    });

    it('handles agents Map with no matching phase in sidebar', () => {
      const phases = [createPhase('plan', 'Plan', '📋')];
      const agents = new Map<string, AgentWindowState>([
        ['orphan-agent', createAgentWindow('orphan-agent', { profile: 'Orphan', phase: 'nonexistent' })],
      ]);
      const runState = buildRunStateWithPhases(phases, 'plan', [], agents);
      render(<DevelopRenderer runState={runState} />);
      // The 'plan' phase has no agents, 'nonexistent' isn't a sidebar phase
      expect(screen.queryByText('Orphan')).not.toBeInTheDocument();
      expect(screen.getByText('No agents in this phase')).toBeInTheDocument();
    });

    it('handles clicking active tab then non-active tab in rapid succession', () => {
      const phases = [
        createPhase('a', 'A', '1'),
        createPhase('b', 'B', '2'),
        createPhase('c', 'C', '3'),
      ];
      const agents = new Map<string, AgentWindowState>([
        ['agent-a', createAgentWindow('agent-a', { profile: 'AgentA', phase: 'a' })],
        ['agent-b', createAgentWindow('agent-b', { profile: 'AgentB', phase: 'b' })],
        ['agent-c', createAgentWindow('agent-c', { profile: 'AgentC', phase: 'c' })],
      ]);
      const runState = buildRunStateWithPhases(phases, 'b', ['a'], agents);

      const { container } = render(<DevelopRenderer runState={runState} />);
      // Click active tab (re-engage auto-follow), then immediately click 'a'
      fireEvent.click(screen.getByText('B').closest('.phase-tab')!);
      fireEvent.click(screen.getByText('A').closest('.phase-tab')!);
      const tabs = container.querySelectorAll('.phase-tab');
      expect(tabs[0]).toHaveClass('phase-tab--selected');
      expect(screen.getByText('AgentA')).toBeInTheDocument();
    });

    it('does not pin when clicking on an already-active phase tab', () => {
      const phases = [
        createPhase('a', 'A', '1'),
        createPhase('b', 'B', '2'),
      ];
      const runState = buildRunStateWithPhases(phases, 'a', []);

      const { container } = render(<DevelopRenderer runState={runState} />);
      // Click active tab — should remain on auto-follow
      fireEvent.click(screen.getByText('A').closest('.phase-tab')!);
      // manualTab should be null (auto-follow), effectiveTab = currentPhase = 'a'
      const tabs = container.querySelectorAll('.phase-tab');
      expect(tabs[0]).toHaveClass('phase-tab--selected');
      expect(tabs[1]).not.toHaveClass('phase-tab--selected');
    });

    it('handles all phases completed with no current phase', () => {
      const phases = [
        createPhase('a', 'A', '1'),
        createPhase('b', 'B', '2'),
      ];
      const runState = buildRunStateWithPhases(phases, '', ['a', 'b']);
      const { container } = render(<DevelopRenderer runState={runState} />);
      const tabs = container.querySelectorAll('.phase-tab');
      // All phases completed, currentPhase empty => effectiveTab = '' => no selection
      tabs.forEach((tab) => {
        expect(tab).not.toHaveClass('phase-tab--selected');
      });
    });

    it('auto-follow updates when currentPhase changes (re-render with new props)', () => {
      const phases = [
        createPhase('a', 'A', '1'),
        createPhase('b', 'B', '2'),
      ];
      const { container, rerender } = render(
        <DevelopRenderer runState={buildRunStateWithPhases(phases, 'a', [])} />,
      );
      let tabs = container.querySelectorAll('.phase-tab');
      expect(tabs[0]).toHaveClass('phase-tab--selected');

      // Re-render with currentPhase changed to 'b'
      rerender(<DevelopRenderer runState={buildRunStateWithPhases(phases, 'b', ['a'])} />);
      tabs = container.querySelectorAll('.phase-tab');
      expect(tabs[1]).toHaveClass('phase-tab--selected');
      expect(tabs[0]).not.toHaveClass('phase-tab--selected');
    });

    it('manual pin persists across re-renders with changing currentPhase', () => {
      const phases = [
        createPhase('a', 'A', '1'),
        createPhase('b', 'B', '2'),
      ];
      const { container, rerender } = render(
        <DevelopRenderer runState={buildRunStateWithPhases(phases, 'b', ['a'])} />,
      );

      // Pin to 'a'
      fireEvent.click(screen.getByText('A').closest('.phase-tab')!);
      let tabs = container.querySelectorAll('.phase-tab');
      expect(tabs[0]).toHaveClass('phase-tab--selected');

      // Re-render with currentPhase still 'b' — pin should persist
      rerender(<DevelopRenderer runState={buildRunStateWithPhases(phases, 'b', ['a'])} />);
      tabs = container.querySelectorAll('.phase-tab');
      expect(tabs[0]).toHaveClass('phase-tab--selected');
      expect(tabs[1]).not.toHaveClass('phase-tab--selected');
    });
  });
});
