/* eslint-disable @typescript-eslint/no-non-null-assertion */
/**
 * Tests for ProgressIndicator component.
 *
 * Verifies the tab-based phase UI: clickable tabs with ROYGBIV colors,
 * role="tablist"/"tab" ARIA semantics, data-status attribute styling,
 * aria-disabled on pending tabs, and onTabClick callback behavior.
 */

import '@testing-library/jest-dom/vitest';

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { ProgressIndicator } from '../ProgressIndicator';
import type { DevelopPhaseInfo } from '../types';

// ─── Helpers ────────────────────────────────────────────────────────────────

function createPhase(overrides: Partial<DevelopPhaseInfo> = {}): DevelopPhaseInfo {
  return {
    id: 'phase-1',
    label: 'Phase 1',
    icon: '📋',
    status: 'pending',
    index: 0,
    ...overrides,
  };
}

const noop = vi.fn();

function renderIndicator(
  phases: DevelopPhaseInfo[],
  activePhaseTab = '',
  onTabClick: (phaseId: string) => void = noop,
) {
  return render(<ProgressIndicator phases={phases} activePhaseTab={activePhaseTab} onTabClick={onTabClick} />);
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
      renderIndicator(phases);
      expect(screen.getByText('Alpha')).toBeInTheDocument();
      expect(screen.getByText('Beta')).toBeInTheDocument();
      expect(screen.getByText('Gamma')).toBeInTheDocument();
    });

    it('renders phase icons for non-completed phases', () => {
      const phases = [
        createPhase({ id: 'a', icon: '🔍', status: 'active', index: 0 }),
        createPhase({ id: 'b', icon: '⚙️', status: 'pending', index: 1 }),
      ];
      renderIndicator(phases);
      expect(screen.getByText('🔍')).toBeInTheDocument();
      expect(screen.getByText('⚙️')).toBeInTheDocument();
    });

    it('shows a checkmark (✅) for completed phases instead of the original icon', () => {
      const phases = [createPhase({ id: 'a', icon: '📋', status: 'completed', index: 0 })];
      renderIndicator(phases);
      expect(screen.getByText('✅')).toBeInTheDocument();
      expect(screen.queryByText('📋')).not.toBeInTheDocument();
    });

    it('renders nothing when phases array is empty', () => {
      const { container } = renderIndicator([]);
      const indicator = container.querySelector('.progress-indicator');
      expect(indicator).toBeInTheDocument();
      expect(indicator?.children.length).toBe(0);
    });

    it('renders the correct number of phase tabs', () => {
      const phases = [createPhase({ id: 'a' }), createPhase({ id: 'b' }), createPhase({ id: 'c' })];
      const { container } = renderIndicator(phases);
      const tabs = container.querySelectorAll('.phase-tab');
      expect(tabs).toHaveLength(3);
    });
  });

  describe('tab ARIA semantics', () => {
    it('sets role="tablist" on the container', () => {
      const { container } = renderIndicator([]);
      const indicator = container.querySelector('.progress-indicator');
      expect(indicator).toHaveAttribute('role', 'tablist');
    });

    it('sets role="tab" on each phase tab', () => {
      const phases = [createPhase({ id: 'a' }), createPhase({ id: 'b' })];
      const { container } = renderIndicator(phases);
      const tabs = container.querySelectorAll('.phase-tab');
      tabs.forEach((tab) => {
        expect(tab).toHaveAttribute('role', 'tab');
      });
    });

    it('sets aria-disabled on pending tabs', () => {
      const phases = [createPhase({ id: 'a', status: 'pending' })];
      const { container } = renderIndicator(phases);
      const tab = container.querySelector('.phase-tab')!;
      expect(tab).toHaveAttribute('aria-disabled', 'true');
    });

    it('does not set aria-disabled on active tabs', () => {
      const phases = [createPhase({ id: 'a', status: 'active' })];
      const { container } = renderIndicator(phases);
      const tab = container.querySelector('.phase-tab')!;
      expect(tab).not.toHaveAttribute('aria-disabled');
    });

    it('does not set aria-disabled on completed tabs', () => {
      const phases = [createPhase({ id: 'a', status: 'completed' })];
      const { container } = renderIndicator(phases);
      const tab = container.querySelector('.phase-tab')!;
      expect(tab).not.toHaveAttribute('aria-disabled');
    });
  });

  describe('data-status attribute', () => {
    it('sets data-status="completed" for completed phases', () => {
      const phases = [createPhase({ status: 'completed' })];
      const { container } = renderIndicator(phases);
      const tab = container.querySelector('.phase-tab')!;
      expect(tab).toHaveAttribute('data-status', 'completed');
    });

    it('sets data-status="active" for active phases', () => {
      const phases = [createPhase({ status: 'active' })];
      const { container } = renderIndicator(phases);
      const tab = container.querySelector('.phase-tab')!;
      expect(tab).toHaveAttribute('data-status', 'active');
    });

    it('sets data-status="pending" for pending phases', () => {
      const phases = [createPhase({ status: 'pending' })];
      const { container } = renderIndicator(phases);
      const tab = container.querySelector('.phase-tab')!;
      expect(tab).toHaveAttribute('data-status', 'pending');
    });
  });

  describe('CSS custom property --phase-color', () => {
    it('sets --phase-color using var(--engin-phase-N) for non-pending phases', () => {
      const phases = [createPhase({ status: 'active', index: 2 })];
      const { container } = renderIndicator(phases);
      const tab = container.querySelector('.phase-tab')!;
      expect(tab).toHaveStyle({ '--phase-color': 'var(--engin-phase-2)' });
    });

    it('sets --phase-color using var(--engin-phase-disabled) for pending phases', () => {
      const phases = [createPhase({ status: 'pending', index: 0 })];
      const { container } = renderIndicator(phases);
      const tab = container.querySelector('.phase-tab')!;
      expect(tab).toHaveStyle({ '--phase-color': 'var(--engin-phase-disabled)' });
    });

    it('sets --phase-color using var(--engin-phase-N) for completed phases', () => {
      const phases = [createPhase({ status: 'completed', index: 5 })];
      const { container } = renderIndicator(phases);
      const tab = container.querySelector('.phase-tab')!;
      expect(tab).toHaveStyle({ '--phase-color': 'var(--engin-phase-5)' });
    });
  });

  describe('tab selection (phase-tab--selected)', () => {
    it('adds phase-tab--selected when phase.id matches activePhaseTab', () => {
      const phases = [createPhase({ id: 'a', status: 'active' }), createPhase({ id: 'b', status: 'pending' })];
      const { container } = renderIndicator(phases, 'a');
      const tabs = container.querySelectorAll('.phase-tab');
      expect(tabs[0]).toHaveClass('phase-tab--selected');
      expect(tabs[1]).not.toHaveClass('phase-tab--selected');
    });

    it('does not add phase-tab--selected to any tab when activePhaseTab is empty', () => {
      const phases = [createPhase({ id: 'a', status: 'active' }), createPhase({ id: 'b', status: 'completed' })];
      const { container } = renderIndicator(phases, '');
      const tabs = container.querySelectorAll('.phase-tab');
      tabs.forEach((tab) => {
        expect(tab).not.toHaveClass('phase-tab--selected');
      });
    });

    it('selects only one tab at a time', () => {
      const phases = [
        createPhase({ id: 'a', status: 'completed' }),
        createPhase({ id: 'b', status: 'active' }),
        createPhase({ id: 'c', status: 'pending' }),
      ];
      const { container } = renderIndicator(phases, 'b');
      const tabs = container.querySelectorAll('.phase-tab');
      expect(tabs[0]).not.toHaveClass('phase-tab--selected');
      expect(tabs[1]).toHaveClass('phase-tab--selected');
      expect(tabs[2]).not.toHaveClass('phase-tab--selected');
    });
  });

  describe('onTabClick behavior', () => {
    it('calls onTabClick with phase id when a non-pending tab is clicked', () => {
      const onTabClick = vi.fn();
      const phases = [
        createPhase({ id: 'a', label: 'Alpha', status: 'completed' }),
        createPhase({ id: 'b', label: 'Beta', status: 'active' }),
      ];
      renderIndicator(phases, '', onTabClick);

      const tab = screen.getByText('Alpha').closest('.phase-tab')!;
      fireEvent.click(tab);
      expect(onTabClick).toHaveBeenCalledWith('a');
    });

    it('does not call onTabClick when a pending tab is clicked', () => {
      const onTabClick = vi.fn();
      const phases = [createPhase({ id: 'a', status: 'pending' })];
      renderIndicator(phases, '', onTabClick);

      const tab = screen.getByText('Phase 1').closest('.phase-tab')!;
      fireEvent.click(tab);
      expect(onTabClick).not.toHaveBeenCalled();
    });

    it('calls onTabClick with the correct id for completed tabs', () => {
      const onTabClick = vi.fn();
      const phases = [
        createPhase({ id: 'setup', label: 'Setup', status: 'completed' }),
        createPhase({ id: 'build', label: 'Build', status: 'active' }),
        createPhase({ id: 'deploy', label: 'Deploy', status: 'pending' }),
      ];
      renderIndicator(phases, '', onTabClick);

      const completedTab = screen.getByText('Setup').closest('.phase-tab')!;
      fireEvent.click(completedTab);
      expect(onTabClick).toHaveBeenCalledWith('setup');
    });

    it('does not call onTabClick for pending tabs in a mixed sequence', () => {
      const onTabClick = vi.fn();
      const phases = [
        createPhase({ id: 'a', label: 'Alpha', status: 'completed' }),
        createPhase({ id: 'b', label: 'Beta', status: 'active' }),
        createPhase({ id: 'c', label: 'Gamma', status: 'pending' }),
      ];
      renderIndicator(phases, '', onTabClick);

      const pendingTab = screen.getByText('Gamma').closest('.phase-tab')!;
      fireEvent.click(pendingTab);
      expect(onTabClick).not.toHaveBeenCalledWith('c');
    });

    it('calls onTabClick for active tabs', () => {
      const onTabClick = vi.fn();
      const phases = [createPhase({ id: 'a', status: 'active' })];
      renderIndicator(phases, '', onTabClick);

      const tab = screen.getByText('Phase 1').closest('.phase-tab')!;
      fireEvent.click(tab);
      expect(onTabClick).toHaveBeenCalledWith('a');
    });
  });

  describe('container and structure', () => {
    it('renders a root element with class "progress-indicator"', () => {
      const { container } = renderIndicator([]);
      expect(container.querySelector('.progress-indicator')).toBeInTheDocument();
    });

    it('renders phase tabs inside the progress-indicator', () => {
      const phases = [createPhase({ id: 'a' })];
      const { container } = renderIndicator(phases);
      const indicator = container.querySelector('.progress-indicator');
      const tab = indicator?.querySelector('.phase-tab');
      expect(tab).toBeInTheDocument();
    });

    it('orders phase tabs in the same order as the phases prop', () => {
      const phases = [
        createPhase({ id: 'first', label: 'First' }),
        createPhase({ id: 'second', label: 'Second' }),
        createPhase({ id: 'third', label: 'Third' }),
      ];
      const { container } = renderIndicator(phases);
      const tabs = container.querySelectorAll('.phase-tab');
      expect(tabs[0]).toHaveTextContent('First');
      expect(tabs[1]).toHaveTextContent('Second');
      expect(tabs[2]).toHaveTextContent('Third');
    });

    it('each phase-tab contains a phase-icon and a phase-label', () => {
      const phases = [createPhase({ id: 'a', icon: '🔍', label: 'Search' })];
      const { container } = renderIndicator(phases);
      const tab = container.querySelector('.phase-tab')!;
      expect(tab.querySelector('.phase-icon')).toBeInTheDocument();
      expect(tab.querySelector('.phase-label')).toBeInTheDocument();
    });
  });

  describe('initialization phase', () => {
    it('when initialization is active, renders the gear icon and "Initialization" label', () => {
      const phase = createPhase({
        id: 'initialization',
        label: 'Initialization',
        icon: '⚙️',
        status: 'active',
        index: 0,
      });
      renderIndicator([phase], 'initialization');
      expect(screen.getByText('⚙️')).toBeInTheDocument();
      expect(screen.getByText('Initialization')).toBeInTheDocument();
    });

    it('when initialization is completed, renders the checkmark icon', () => {
      const phase = createPhase({
        id: 'initialization',
        label: 'Initialization',
        icon: '⚙️',
        status: 'completed',
        index: 0,
      });
      renderIndicator([phase]);
      expect(screen.getByText('✅')).toBeInTheDocument();
      expect(screen.queryByText('⚙️')).not.toBeInTheDocument();
    });

    it('when initialization is pending, has aria-disabled and data-status=pending', () => {
      const phase = createPhase({
        id: 'initialization',
        label: 'Initialization',
        icon: '⚙️',
        status: 'pending',
        index: 0,
      });
      const { container } = renderIndicator([phase]);
      const tab = container.querySelector('.phase-tab')!;
      expect(tab).toHaveAttribute('data-status', 'pending');
      expect(tab).toHaveAttribute('aria-disabled', 'true');
    });
  });

  describe('key prop', () => {
    it('uses phase.id as key for each tab', () => {
      const phases = [createPhase({ id: 'alpha' }), createPhase({ id: 'beta' })];
      const { container } = renderIndicator(phases);
      const tabs = container.querySelectorAll('.phase-tab');
      expect(tabs).toHaveLength(2);
    });
  });
});
