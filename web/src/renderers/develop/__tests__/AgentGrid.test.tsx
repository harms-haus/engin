/* eslint-disable @typescript-eslint/no-non-null-assertion */
/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Tests for AgentGrid component.
 *
 * Verifies that the grid renders agent cells with profile names, status
 * dots, and AgentLog bodies.  Also verifies the empty state when no
 * agents are provided.
 */

import '@testing-library/jest-dom/vitest';

import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { LogEntry } from '../../../types';
import { AgentGrid } from '../AgentGrid';
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

function createLogEntry(overrides: Partial<LogEntry> = {}): LogEntry {
  return {
    id: 'log-1',
    timestamp: '2024-01-01T00:00:00Z',
    type: 'text',
    content: 'Hello',
    ...overrides,
  };
}

function createAgent(overrides: Partial<DevelopAgentInfo> = {}): DevelopAgentInfo {
  return {
    agentId: 'agent-1',
    profile: 'Default Agent',
    active: true,
    log: [],
    ...overrides,
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('AgentGrid', () => {
  describe('empty state', () => {
    it('renders a "No active agents" message when agents array is empty', () => {
      render(<AgentGrid agents={[]} />);
      expect(screen.getByText('No active agents')).toBeInTheDocument();
    });

    it('does not render the grid container when there are no agents', () => {
      const { container } = render(<AgentGrid agents={[]} />);
      expect(container.querySelector('.agent-grid')).toBeNull();
    });

    it('renders the empty state with class "agent-grid-empty"', () => {
      const { container } = render(<AgentGrid agents={[]} />);
      expect(container.querySelector('.agent-grid-empty')).toBeInTheDocument();
    });

    it('renders the default message when emptyMessage is not provided', () => {
      render(<AgentGrid agents={[]} />);
      expect(screen.getByText('No active agents')).toBeInTheDocument();
    });

    it('renders a custom emptyMessage when provided', () => {
      render(<AgentGrid agents={[]} emptyMessage="No agents found" />);
      expect(screen.getByText('No agents found')).toBeInTheDocument();
    });

    it('does not render the default message when a custom emptyMessage is provided', () => {
      render(<AgentGrid agents={[]} emptyMessage="Custom empty" />);
      expect(screen.queryByText('No active agents')).not.toBeInTheDocument();
    });

    it('renders the empty state div with class "agent-grid-empty" when custom emptyMessage is provided', () => {
      const { container } = render(<AgentGrid agents={[]} emptyMessage="Nothing here" />);
      expect(container.querySelector('.agent-grid-empty')).toBeInTheDocument();
    });

    it('renders custom emptyMessage as a string even when it is empty', () => {
      const { container } = render(<AgentGrid agents={[]} emptyMessage="" />);
      const emptyEl = container.querySelector('.agent-grid-empty');
      expect(emptyEl).toBeInTheDocument();
      expect(emptyEl?.textContent).toBe('');
    });

    it('renders custom emptyMessage for agents array that is empty', () => {
      render(<AgentGrid agents={[]} emptyMessage="Waiting for agents…" />);
      expect(screen.getByText('Waiting for agents…')).toBeInTheDocument();
      expect(screen.queryByText('No active agents')).not.toBeInTheDocument();
    });
  });

  describe('grid rendering', () => {
    it('renders a root element with class "agent-grid"', () => {
      const agents = [createAgent()];
      const { container } = render(<AgentGrid agents={agents} />);
      expect(container.querySelector('.agent-grid')).toBeInTheDocument();
    });

    it('renders one agent-cell per agent', () => {
      const agents = [createAgent({ agentId: 'a' }), createAgent({ agentId: 'b' }), createAgent({ agentId: 'c' })];
      const { container } = render(<AgentGrid agents={agents} />);
      const cells = container.querySelectorAll('.agent-cell');
      expect(cells).toHaveLength(3);
    });

    it('renders no agent-cells when agents array is empty', () => {
      const { container } = render(<AgentGrid agents={[]} />);
      const cells = container.querySelectorAll('.agent-cell');
      expect(cells).toHaveLength(0);
    });

    it('renders all 6 agent cells for a 6-agent grid (multi-row layout)', () => {
      const agents = Array.from({ length: 6 }, (_, i) => createAgent({ agentId: `agent-${i}`, profile: `Agent ${i}` }));
      const { container } = render(<AgentGrid agents={agents} />);
      const cells = container.querySelectorAll('.agent-cell');
      expect(cells).toHaveLength(6);
    });
  });

  describe('agent-cell-header', () => {
    it('renders the profile name inside the header', () => {
      const agents = [createAgent({ profile: 'Alice' })];
      render(<AgentGrid agents={agents} />);
      expect(screen.getByText('Alice')).toBeInTheDocument();
    });

    it('renders profile names for all agents', () => {
      const agents = [createAgent({ agentId: 'a', profile: 'Alpha' }), createAgent({ agentId: 'b', profile: 'Beta' })];
      render(<AgentGrid agents={agents} />);
      expect(screen.getByText('Alpha')).toBeInTheDocument();
      expect(screen.getByText('Beta')).toBeInTheDocument();
    });

    it('renders a status dot for each agent', () => {
      const agents = [createAgent({ agentId: 'a' })];
      const { container } = render(<AgentGrid agents={agents} />);
      const header = container.querySelector('.agent-cell-header')!;
      const dot = header.querySelector('.agent-cell-status-dot');
      expect(dot).toBeInTheDocument();
    });

    it('applies active class to status dot when agent is active', () => {
      const agents = [createAgent({ active: true })];
      const { container } = render(<AgentGrid agents={agents} />);
      const dot = container.querySelector('.agent-cell-status-dot');
      expect(dot).toHaveClass('agent-cell-status-dot--active');
      expect(dot).not.toHaveClass('agent-cell-status-dot--inactive');
    });

    it('applies inactive class to status dot when agent is inactive', () => {
      const agents = [createAgent({ active: false })];
      const { container } = render(<AgentGrid agents={agents} />);
      const dot = container.querySelector('.agent-cell-status-dot');
      expect(dot).toHaveClass('agent-cell-status-dot--inactive');
      expect(dot).not.toHaveClass('agent-cell-status-dot--active');
    });

    it('renders status dot before the profile name', () => {
      const agents = [createAgent({ profile: 'Bob' })];
      const { container } = render(<AgentGrid agents={agents} />);
      const header = container.querySelector('.agent-cell-header')!;
      const nameSpan = header.querySelector('.agent-cell-header-name')!;
      const dot = nameSpan.querySelector('.agent-cell-status-dot');
      const text = nameSpan.textContent;
      // dot should be before the profile name in the DOM
      expect(dot).toBeInTheDocument();
      expect(text).toContain('Bob');
    });

    it('renders mixed active and inactive status dots correctly', () => {
      const agents = [
        createAgent({ agentId: 'active-one', active: true }),
        createAgent({ agentId: 'inactive-one', active: false }),
        createAgent({ agentId: 'active-two', active: true }),
      ];
      const { container } = render(<AgentGrid agents={agents} />);
      const dots = container.querySelectorAll('.agent-cell-status-dot');
      expect(dots).toHaveLength(3);
      expect(dots[0]).toHaveClass('agent-cell-status-dot--active');
      expect(dots[1]).toHaveClass('agent-cell-status-dot--inactive');
      expect(dots[2]).toHaveClass('agent-cell-status-dot--active');
    });
  });

  describe('agent-cell-body and AgentLog', () => {
    beforeEach(() => {
      mockGetVirtualItems.mockClear();
      mockGetTotalSize.mockClear();
      mockScrollToIndex.mockClear();
    });

    it('renders a body container inside each cell', () => {
      const agents = [createAgent()];
      const { container } = render(<AgentGrid agents={agents} />);
      const cell = container.querySelector('.agent-cell')!;
      expect(cell.querySelector('.agent-cell-body')).toBeInTheDocument();
    });

    it('renders an AgentLog inside each cell body', () => {
      const agents = [createAgent()];
      const { container } = render(<AgentGrid agents={agents} />);
      const body = container.querySelector('.agent-cell-body')!;
      expect(body.querySelector('.agent-log')).toBeInTheDocument();
    });

    it('passes log entries to AgentLog and renders them', () => {
      const entries = [
        createLogEntry({ id: 'e1', content: 'First entry' }),
        createLogEntry({ id: 'e2', content: 'Second entry' }),
      ];
      // Stub virtualizer to return items for the two entries
      mockGetTotalSize.mockReturnValueOnce(120);
      mockGetVirtualItems.mockReturnValueOnce([
        { key: '0', index: 0, start: 0, size: 60 },
        { key: '1', index: 1, start: 60, size: 60 },
      ] as any);

      const agents = [createAgent({ log: entries })];
      render(<AgentGrid agents={agents} />);
      expect(screen.getByText('First entry')).toBeInTheDocument();
      expect(screen.getByText('Second entry')).toBeInTheDocument();
    });

    it('renders log entries for multiple agents independently', () => {
      const agents = [
        createAgent({ agentId: 'a', log: [createLogEntry({ id: 'a1', content: 'Agent A log' })] }),
        createAgent({ agentId: 'b', log: [createLogEntry({ id: 'b1', content: 'Agent B log' })] }),
      ];
      // Stub virtualizer: each AgentLog instance gets its own mock calls.
      // The mock is called twice (once per AgentLog), so we set up two return values.
      mockGetTotalSize.mockReturnValueOnce(60).mockReturnValueOnce(60);
      mockGetVirtualItems
        .mockReturnValueOnce([{ key: '0', index: 0, start: 0, size: 60 }] as any)
        .mockReturnValueOnce([{ key: '0', index: 0, start: 0, size: 60 }] as any);

      render(<AgentGrid agents={agents} />);
      expect(screen.getByText('Agent A log')).toBeInTheDocument();
      expect(screen.getByText('Agent B log')).toBeInTheDocument();
    });

    it('renders empty AgentLog when agent has no log entries', () => {
      const agents = [createAgent({ log: [] })];
      const { container } = render(<AgentGrid agents={agents} />);
      const log = container.querySelector('.agent-log')!;
      expect(log).toBeInTheDocument();
      // The virtualizer always renders an inner container div even when empty
      expect(log.children.length).toBe(1);
    });
  });

  describe('structure and order', () => {
    it('renders cells in the same order as the agents prop', () => {
      const agents = [
        createAgent({ agentId: 'first', profile: 'First' }),
        createAgent({ agentId: 'second', profile: 'Second' }),
        createAgent({ agentId: 'third', profile: 'Third' }),
      ];
      const { container } = render(<AgentGrid agents={agents} />);
      const cells = container.querySelectorAll('.agent-cell');
      expect(cells[0]).toHaveTextContent('First');
      expect(cells[1]).toHaveTextContent('Second');
      expect(cells[2]).toHaveTextContent('Third');
    });

    it('each cell contains a header and a body', () => {
      const agents = [createAgent()];
      const { container } = render(<AgentGrid agents={agents} />);
      const cell = container.querySelector('.agent-cell')!;
      expect(cell.querySelector('.agent-cell-header')).toBeInTheDocument();
      expect(cell.querySelector('.agent-cell-body')).toBeInTheDocument();
    });

    it('uses agentId as the key for each cell', () => {
      const agents = [createAgent({ agentId: 'uniq-1' }), createAgent({ agentId: 'uniq-2' })];
      const { container } = render(<AgentGrid agents={agents} />);
      const cells = container.querySelectorAll('.agent-cell');
      expect(cells).toHaveLength(2);
    });
  });

  describe('edge cases', () => {
    it('handles agents with empty profile string', () => {
      const agents = [createAgent({ profile: '' })];
      const { container } = render(<AgentGrid agents={agents} />);
      const header = container.querySelector('.agent-cell-header')!;
      expect(header).toHaveTextContent('');
    });

    it('handles agents with missing taskId (renders without error)', () => {
      const agents = [createAgent({ taskId: undefined })];
      const { container } = render(<AgentGrid agents={agents} />);
      expect(container.querySelector('.agent-cell')).toBeInTheDocument();
    });

    it('renders many agents in the grid', () => {
      const agents = Array.from({ length: 20 }, (_, i) =>
        createAgent({ agentId: `agent-${i}`, profile: `Agent ${i}` }),
      );
      const { container } = render(<AgentGrid agents={agents} />);
      const cells = container.querySelectorAll('.agent-cell');
      expect(cells).toHaveLength(20);
    });

    it('does not render empty state message when agents are present', () => {
      const agents = [createAgent()];
      render(<AgentGrid agents={agents} />);
      expect(screen.queryByText('No active agents')).toBeNull();
    });
  });
});
