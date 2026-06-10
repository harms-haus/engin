/* eslint-disable @typescript-eslint/no-non-null-assertion */
/**
 * Tests for ProgressIndicator component.
 *
 * Verifies that the horizontal phase bar renders phases with correct
 * styling based on status (completed / active / pending) and that
 * connector lines appear between phases with appropriate color.
 */

import '@testing-library/jest-dom/vitest';

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { ProgressIndicator } from '../ProgressIndicator';
import type { DevelopPhaseInfo } from '../types';

// ─── Helpers ────────────────────────────────────────────────────────────────

function createPhase(overrides: Partial<DevelopPhaseInfo> = {}): DevelopPhaseInfo {
  return {
    id: 'phase-1',
    label: 'Phase 1',
    icon: '📋',
    status: 'pending',
    ...overrides,
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('ProgressIndicator', () => {
  describe('rendering phases', () => {
    it('renders each phase label', () => {
      const phases = [
        createPhase({ id: 'a', label: 'Alpha' }),
        createPhase({ id: 'b', label: 'Beta' }),
        createPhase({ id: 'c', label: 'Gamma' }),
      ];
      render(<ProgressIndicator phases={phases} />);
      expect(screen.getByText('Alpha')).toBeInTheDocument();
      expect(screen.getByText('Beta')).toBeInTheDocument();
      expect(screen.getByText('Gamma')).toBeInTheDocument();
    });

    it('renders phase icons for non-completed phases', () => {
      const phases = [
        createPhase({ id: 'a', icon: '🔍', status: 'active' }),
        createPhase({ id: 'b', icon: '⚙️', status: 'pending' }),
      ];
      render(<ProgressIndicator phases={phases} />);
      expect(screen.getByText('🔍')).toBeInTheDocument();
      expect(screen.getByText('⚙️')).toBeInTheDocument();
    });

    it('shows a checkmark (✅) for completed phases instead of the original icon', () => {
      const phases = [createPhase({ id: 'a', icon: '📋', status: 'completed' })];
      render(<ProgressIndicator phases={phases} />);
      expect(screen.getByText('✅')).toBeInTheDocument();
      expect(screen.queryByText('📋')).not.toBeInTheDocument();
    });

    it('renders nothing when phases array is empty', () => {
      const { container } = render(<ProgressIndicator phases={[]} />);
      const indicator = container.querySelector('.progress-indicator');
      expect(indicator).toBeInTheDocument();
      expect(indicator?.children.length).toBe(0);
    });

    it('renders the correct number of phase items', () => {
      const phases = [createPhase({ id: 'a' }), createPhase({ id: 'b' }), createPhase({ id: 'c' })];
      const { container } = render(<ProgressIndicator phases={phases} />);
      const items = container.querySelectorAll('.phase-item');
      expect(items).toHaveLength(3);
    });
  });

  describe('status styling', () => {
    it('applies "completed" class for completed phases', () => {
      const phases = [createPhase({ status: 'completed' })];
      const { container } = render(<ProgressIndicator phases={phases} />);
      const item = container.querySelector('.phase-item');
      expect(item).toHaveClass('completed');
      expect(item).not.toHaveClass('active');
      expect(item).not.toHaveClass('pending');
    });

    it('applies "active" class for active phases', () => {
      const phases = [createPhase({ status: 'active' })];
      const { container } = render(<ProgressIndicator phases={phases} />);
      const item = container.querySelector('.phase-item');
      expect(item).toHaveClass('active');
      expect(item).not.toHaveClass('completed');
      expect(item).not.toHaveClass('pending');
    });

    it('applies "pending" class for pending phases', () => {
      const phases = [createPhase({ status: 'pending' })];
      const { container } = render(<ProgressIndicator phases={phases} />);
      const item = container.querySelector('.phase-item');
      expect(item).toHaveClass('pending');
      expect(item).not.toHaveClass('completed');
      expect(item).not.toHaveClass('active');
    });
  });

  describe('connectors', () => {
    it('renders a connector between each pair of phases', () => {
      const phases = [createPhase({ id: 'a' }), createPhase({ id: 'b' }), createPhase({ id: 'c' })];
      const { container } = render(<ProgressIndicator phases={phases} />);
      const connectors = container.querySelectorAll('.phase-connector');
      expect(connectors).toHaveLength(2); // 3 phases → 2 connectors
    });

    it('does not render a connector after the last phase', () => {
      const phases = [createPhase({ id: 'a' }), createPhase({ id: 'b' })];
      const { container } = render(<ProgressIndicator phases={phases} />);
      const lastItem = container.querySelector('.phase-item:last-child');
      expect(lastItem?.querySelector('.phase-connector')).toBeNull();
    });

    it('renders no connectors when there is only one phase', () => {
      const phases = [createPhase({ id: 'a' })];
      const { container } = render(<ProgressIndicator phases={phases} />);
      const connectors = container.querySelectorAll('.phase-connector');
      expect(connectors).toHaveLength(0);
    });

    it('applies "completed" class to connector after a completed phase', () => {
      const phases = [createPhase({ id: 'a', status: 'completed' }), createPhase({ id: 'b', status: 'active' })];
      const { container } = render(<ProgressIndicator phases={phases} />);
      const connector = container.querySelector('.phase-connector');
      expect(connector).toHaveClass('completed');
    });

    it('applies "pending" class to connector after a non-completed (active) phase', () => {
      const phases = [createPhase({ id: 'a', status: 'active' }), createPhase({ id: 'b', status: 'pending' })];
      const { container } = render(<ProgressIndicator phases={phases} />);
      const connector = container.querySelector('.phase-connector');
      expect(connector).toHaveClass('pending');
    });

    it('applies "pending" class to connector after a pending phase', () => {
      const phases = [createPhase({ id: 'a', status: 'pending' }), createPhase({ id: 'b', status: 'pending' })];
      const { container } = render(<ProgressIndicator phases={phases} />);
      const connector = container.querySelector('.phase-connector');
      expect(connector).toHaveClass('pending');
    });

    it('uses green connector after completed, gray after non-completed in mixed sequence', () => {
      const phases = [
        createPhase({ id: 'a', status: 'completed' }),
        createPhase({ id: 'b', status: 'completed' }),
        createPhase({ id: 'c', status: 'active' }),
        createPhase({ id: 'd', status: 'pending' }),
      ];
      const { container } = render(<ProgressIndicator phases={phases} />);
      const connectors = container.querySelectorAll('.phase-connector');
      expect(connectors).toHaveLength(3);
      // After phase 0 (completed) → completed
      expect(connectors[0]).toHaveClass('completed');
      // After phase 1 (completed) → completed
      expect(connectors[1]).toHaveClass('completed');
      // After phase 2 (active) → pending
      expect(connectors[2]).toHaveClass('pending');
    });
  });

  describe('container and structure', () => {
    it('renders a root element with class "progress-indicator"', () => {
      const { container } = render(<ProgressIndicator phases={[]} />);
      expect(container.querySelector('.progress-indicator')).toBeInTheDocument();
    });

    it('renders phase items inside the progress-indicator', () => {
      const phases = [createPhase({ id: 'a' })];
      const { container } = render(<ProgressIndicator phases={phases} />);
      const indicator = container.querySelector('.progress-indicator');
      const item = indicator?.querySelector('.phase-item');
      expect(item).toBeInTheDocument();
    });

    it('orders phase items in the same order as the phases prop', () => {
      const phases = [
        createPhase({ id: 'first', label: 'First' }),
        createPhase({ id: 'second', label: 'Second' }),
        createPhase({ id: 'third', label: 'Third' }),
      ];
      const { container } = render(<ProgressIndicator phases={phases} />);
      const items = container.querySelectorAll('.phase-item');
      expect(items[0]).toHaveTextContent('First');
      expect(items[1]).toHaveTextContent('Second');
      expect(items[2]).toHaveTextContent('Third');
    });

    it('each phase-item contains a phase-icon and a phase-label', () => {
      const phases = [createPhase({ id: 'a', icon: '🔍', label: 'Search' })];
      const { container } = render(<ProgressIndicator phases={phases} />);
      const item = container.querySelector('.phase-item')!;
      expect(item.querySelector('.phase-icon')).toBeInTheDocument();
      expect(item.querySelector('.phase-label')).toBeInTheDocument();
    });
  });
});
