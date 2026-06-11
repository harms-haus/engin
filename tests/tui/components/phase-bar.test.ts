import { visibleWidth } from '@earendil-works/pi-tui';
import { describe, expect, it } from 'bun:test';
import { PhaseBar } from '../../../src/tui/components/phase-bar.js';

describe('PhaseBar', () => {
  // ── Empty state ────────────────────────────────────────────────────
  it('renders empty state (no phases, no indicator)', () => {
    const bar = new PhaseBar();
    const lines = bar.render(40);
    expect(lines).toHaveLength(1);
    // Empty indicator + empty phaseId => just whitespace padding
    expect(visibleWidth(lines[0])).toBe(40);
  });

  // ── Phase markers ──────────────────────────────────────────────────
  it('renders phases with correct markers (completed ✓, current ●, pending ·)', () => {
    const bar = new PhaseBar();
    bar.setPhases([
      { id: 'plan', label: 'Plan', icon: '📋' },
      { id: 'implement', label: 'Implement', icon: '⚙️' },
      { id: 'review', label: 'Review', icon: '🔍' },
    ]);
    bar.setCompletedPhases(['plan']);
    bar.setCurrentPhase('implement');

    const lines = bar.render(80);
    expect(lines).toHaveLength(1);
    const line = lines[0];

    // Should contain ✓ for completed, ● for current, · for pending
    expect(line).toContain('✓');
    expect(line).toContain('●');
    expect(line).toContain('·');

    // Labels should appear
    expect(line).toContain('Plan');
    expect(line).toContain('Implement');
    expect(line).toContain('Review');

    expect(visibleWidth(line)).toBe(80);
  });

  // ── Truncation ─────────────────────────────────────────────────────
  it('truncates to width', () => {
    const bar = new PhaseBar();
    bar.setPhases([
      { id: 'one', label: 'Phase One', icon: '1' },
      { id: 'two', label: 'Phase Two', icon: '2' },
      { id: 'three', label: 'Phase Three', icon: '3' },
      { id: 'four', label: 'Phase Four', icon: '4' },
    ]);
    bar.setCurrentPhase('two');

    const lines = bar.render(20);
    expect(lines).toHaveLength(1);
    expect(visibleWidth(lines[0])).toBe(20);
  });

  // ── Indicator prefix ───────────────────────────────────────────────
  it('renders with indicator prefix', () => {
    const bar = new PhaseBar();
    bar.setIndicator('▶');
    bar.setPhases([{ id: 'plan', label: 'Plan', icon: '📋' }]);
    bar.setCurrentPhase('plan');

    const lines = bar.render(60);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('▶');
  });

  // ── State updates ──────────────────────────────────────────────────
  it('setPhases/setCurrentPhase/setCompletedPhases update output', () => {
    const bar = new PhaseBar();

    // Initially empty
    let lines = bar.render(60);
    expect(visibleWidth(lines[0])).toBe(60);

    // Set phases
    bar.setPhases([
      { id: 'a', label: 'Alpha', icon: 'A' },
      { id: 'b', label: 'Beta', icon: 'B' },
    ]);
    bar.setCurrentPhase('a');
    lines = bar.render(60);
    expect(lines[0]).toContain('●');
    expect(lines[0]).toContain('Alpha');
    expect(lines[0]).toContain('·');
    expect(lines[0]).toContain('Beta');

    // Complete phase a, move to b
    bar.setCompletedPhases(['a']);
    bar.setCurrentPhase('b');
    lines = bar.render(60);
    expect(lines[0]).toContain('✓');
    expect(lines[0]).toContain('●');

    // Complete all
    bar.setCompletedPhases(['a', 'b']);
    lines = bar.render(60);
    expect(lines[0]).toContain('✓');
    expect(lines[0]).not.toContain('●');
  });

  // ── Caching ────────────────────────────────────────────────────────
  it('caches output when render is called with same width and no changes', () => {
    const bar = new PhaseBar();
    bar.setPhases([{ id: 'x', label: 'X', icon: 'X' }]);
    bar.setCurrentPhase('x');

    const first = bar.render(60);
    const second = bar.render(60);

    // Same reference (cached)
    expect(second).toBe(first);
  });

  it('busts cache when state changes', () => {
    const bar = new PhaseBar();
    bar.setPhases([{ id: 'x', label: 'X', icon: 'X' }]);
    bar.setCurrentPhase('x');

    const first = bar.render(60);

    bar.setCurrentPhase('y');
    const second = bar.render(60);

    // Different arrays (cache was busted)
    expect(second).not.toBe(first);
  });

  it('busts cache when width changes', () => {
    const bar = new PhaseBar();
    bar.setPhases([{ id: 'x', label: 'X', icon: 'X' }]);

    const first = bar.render(60);
    const second = bar.render(40);

    expect(visibleWidth(first[0])).toBe(60);
    expect(visibleWidth(second[0])).toBe(40);
    expect(second).not.toBe(first);
  });

  // ── No phases with indicator and currentPhaseId ────────────────────
  it('renders indicator and currentPhaseId when no phases', () => {
    const bar = new PhaseBar();
    bar.setIndicator('⚙');
    bar.setCurrentPhase('custom-phase');

    const lines = bar.render(40);
    expect(lines[0]).toContain('⚙');
    expect(lines[0]).toContain('custom-phase');
  });

  it('renders only indicator when no phases and no currentPhaseId', () => {
    const bar = new PhaseBar();
    bar.setIndicator('▶');

    const lines = bar.render(40);
    expect(lines[0]).toContain('▶');
    expect(visibleWidth(lines[0])).toBe(40);
  });
});
