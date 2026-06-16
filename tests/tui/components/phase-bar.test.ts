import { visibleWidth } from '@earendil-works/pi-tui';
import { describe, expect, it } from 'bun:test';
import { PhaseBar, type PhaseEntity } from '../../../packages/tui/src/components/phase-bar.js';

// Arrow key escape sequences
const LEFT_ARROW = '\x1b[D';
const RIGHT_ARROW = '\x1b[C';

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
      { id: 'plan', label: 'Plan', icon: '📋', taskIds: [] },
      { id: 'implement', label: 'Implement', icon: '⚙️', taskIds: [] },
      { id: 'review', label: 'Review', icon: '🔍', taskIds: [] },
    ]);
    bar.setCompletedPhaseIds(['plan']);
    bar.setCurrentPhaseId('implement');

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
      { id: 'one', label: 'Phase One', icon: '1', taskIds: [] },
      { id: 'two', label: 'Phase Two', icon: '2', taskIds: [] },
      { id: 'three', label: 'Phase Three', icon: '3', taskIds: [] },
      { id: 'four', label: 'Phase Four', icon: '4', taskIds: [] },
    ]);
    bar.setCurrentPhaseId('two');

    const lines = bar.render(20);
    expect(lines).toHaveLength(1);
    expect(visibleWidth(lines[0])).toBe(20);
  });

  // ── Indicator prefix ───────────────────────────────────────────────
  it('renders with indicator prefix', () => {
    const bar = new PhaseBar();
    bar.setIndicator('▶');
    bar.setPhases([{ id: 'plan', label: 'Plan', icon: '📋', taskIds: [] }]);
    bar.setCurrentPhaseId('plan');

    const lines = bar.render(60);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('▶');
  });

  // ── State updates ──────────────────────────────────────────────────
  it('setPhases/setCurrentPhaseId/setCompletedPhaseIds update output', () => {
    const bar = new PhaseBar();

    // Initially empty
    let lines = bar.render(60);
    expect(visibleWidth(lines[0])).toBe(60);

    // Set phases
    bar.setPhases([
      { id: 'a', label: 'Alpha', icon: 'A', taskIds: [] },
      { id: 'b', label: 'Beta', icon: 'B', taskIds: [] },
    ]);
    bar.setCurrentPhaseId('a');
    lines = bar.render(60);
    expect(lines[0]).toContain('●');
    expect(lines[0]).toContain('Alpha');
    expect(lines[0]).toContain('·');
    expect(lines[0]).toContain('Beta');

    // Complete phase a, move to b
    bar.setCompletedPhaseIds(['a']);
    bar.setCurrentPhaseId('b');
    lines = bar.render(60);
    expect(lines[0]).toContain('✓');
    expect(lines[0]).toContain('●');

    // Complete all
    bar.setCompletedPhaseIds(['a', 'b']);
    lines = bar.render(60);
    expect(lines[0]).toContain('✓');
    expect(lines[0]).not.toContain('●');
  });

  // ── Caching ────────────────────────────────────────────────────────
  it('caches output when render is called with same width and no changes', () => {
    const bar = new PhaseBar();
    bar.setPhases([{ id: 'x', label: 'X', icon: 'X', taskIds: [] }]);
    bar.setCurrentPhaseId('x');

    const first = bar.render(60);
    const second = bar.render(60);

    // Same reference (cached)
    expect(second).toBe(first);
  });

  it('busts cache when state changes', () => {
    const bar = new PhaseBar();
    bar.setPhases([{ id: 'x', label: 'X', icon: 'X', taskIds: [] }]);
    bar.setCurrentPhaseId('x');

    const first = bar.render(60);

    bar.setCurrentPhaseId('y');
    const second = bar.render(60);

    // Different arrays (cache was busted)
    expect(second).not.toBe(first);
  });

  it('busts cache when width changes', () => {
    const bar = new PhaseBar();
    bar.setPhases([{ id: 'x', label: 'X', icon: 'X', taskIds: [] }]);

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
    bar.setCurrentPhaseId('custom-phase');

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

// ─── Underline / Selection ──────────────────────────────────────────────

describe('PhaseBar underline selection', () => {
  it('setSelectedPhase underlines the correct phase label', () => {
    const bar = new PhaseBar();
    bar.setPhases([
      { id: 'a', label: 'Alpha', icon: 'A', taskIds: [] },
      { id: 'b', label: 'Beta', icon: 'B', taskIds: [] },
      { id: 'c', label: 'Gamma', icon: 'C', taskIds: [] },
    ]);
    bar.setCurrentPhaseId('a');
    bar.setSelectedPhase('b');

    const lines = bar.render(80);
    const line = lines[0];

    // Beta's label should have underline escape code \x1b[4m
    expect(line).toContain('\x1b[4m');
    // Only one underline (for Beta only)
    // eslint-disable-next-line no-control-regex
    const underlineCount = (line.match(/\x1b\[4m/g) || []).length;
    expect(underlineCount).toBe(1);
  });

  it('when selectedPhaseId is null, underline follows currentPhaseId', () => {
    const bar = new PhaseBar();
    bar.setPhases([
      { id: 'a', label: 'Alpha', icon: 'A', taskIds: [] },
      { id: 'b', label: 'Beta', icon: 'B', taskIds: [] },
    ]);
    bar.setCurrentPhaseId('a');
    // Do NOT call setSelectedPhase → selectedPhaseId remains null

    const lines = bar.render(80);
    const line = lines[0];

    // Underline should be on Alpha (the current phase) since selectedPhaseId is null
    expect(line).toContain('\x1b[4m');
    // eslint-disable-next-line no-control-regex
    const underlineCount = (line.match(/\x1b\[4m/g) || []).length;
    expect(underlineCount).toBe(1);
  });

  it('setCurrentPhaseId resets selection (setSelectedPhase then setCurrentPhaseId)', () => {
    const bar = new PhaseBar();
    bar.setPhases([
      { id: 'a', label: 'Alpha', icon: 'A', taskIds: [] },
      { id: 'b', label: 'Beta', icon: 'B', taskIds: [] },
      { id: 'c', label: 'Gamma', icon: 'C', taskIds: [] },
    ]);
    bar.setCurrentPhaseId('a');
    bar.setSelectedPhase('b');

    // Verify 'b' is underlined
    let lines = bar.render(80);
    expect(lines[0]).toContain('\x1b[4m');

    // Now setCurrentPhaseId('c') should reset selection to null
    bar.setCurrentPhaseId('c');
    lines = bar.render(80);
    const line = lines[0];

    // Gamma (now current, effectiveSelected = null ?? 'c' = 'c') should be underlined
    expect(line).toContain('\x1b[4m');
    // Only one underline (for Gamma, not Beta)
    // eslint-disable-next-line no-control-regex
    const underlineCount = (line.match(/\x1b\[4m/g) || []).length;
    expect(underlineCount).toBe(1);
  });

  it('a completed phase that is also selected shows both ✓ and underline', () => {
    const bar = new PhaseBar();
    bar.setPhases([
      { id: 'a', label: 'Alpha', icon: 'A', taskIds: [] },
      { id: 'b', label: 'Beta', icon: 'B', taskIds: [] },
      { id: 'c', label: 'Gamma', icon: 'C', taskIds: [] },
    ]);
    bar.setCompletedPhaseIds(['a']);
    bar.setCurrentPhaseId('b');
    bar.setSelectedPhase('a'); // Select the completed phase

    const lines = bar.render(80);
    const line = lines[0];

    // Should contain ✓ (completed icon) and underline escape
    expect(line).toContain('✓');
    expect(line).toContain('\x1b[4m');
    // Only one underline (for the selected completed phase)
    // eslint-disable-next-line no-control-regex
    const underlineCount = (line.match(/\x1b\[4m/g) || []).length;
    expect(underlineCount).toBe(1);
  });

  it('invalidate() cache-busts after setSelectedPhase', () => {
    const bar = new PhaseBar();
    bar.setPhases([
      { id: 'a', label: 'Alpha', icon: 'A', taskIds: [] },
      { id: 'b', label: 'Beta', icon: 'B', taskIds: [] },
    ]);
    bar.setCurrentPhaseId('a');

    const first = bar.render(60);

    // setSelectedPhase should invalidate cache
    bar.setSelectedPhase('b');
    const second = bar.render(60);

    expect(second).not.toBe(first);
  });

  it('selected pending phase label is underlined and NOT dimmed', () => {
    const bar = new PhaseBar();
    bar.setPhases([
      { id: 'a', label: 'Alpha', icon: 'A', taskIds: [] },
      { id: 'b', label: 'Beta', icon: 'B', taskIds: [] },
      { id: 'c', label: 'Gamma', icon: 'C', taskIds: [] },
    ]);
    bar.setCurrentPhaseId('a'); // Alpha is running
    bar.setSelectedPhase('b'); // Beta is pending + selected

    const lines = bar.render(80);
    const line = lines[0];

    // Phase b (Beta) is selected + pending: should have underline escape
    // eslint-disable-next-line no-control-regex
    const underlineCount = (line.match(/\x1b\[4m/g) || []).length;
    expect(underlineCount).toBe(1);

    // The underline escape must immediately precede 'Beta' (not preceded by dim '\x1b[2m')
    expect(line).toContain('\x1b[4mBeta\x1b[0m');
    // Must NOT contain dim-wrapped Beta (dim then underline)
    expect(line).not.toContain('\x1b[2m\x1b[4mBeta');

    // Phase a (Alpha) is running: should show cyan ●
    expect(line).toContain('\x1b[36m●\x1b[0m');

    // Phase c (Gamma) is pending + not selected: should show dim ·
    expect(line).toContain('\x1b[2m·\x1b[0m');
  });
});

// ─── handleInput navigation ────────────────────────────────────────────

describe('PhaseBar handleInput navigation', () => {
  const phases: PhaseEntity[] = [
    { id: 'a', label: 'Alpha', icon: 'A', taskIds: [] },
    { id: 'b', label: 'Beta', icon: 'B', taskIds: [] },
    { id: 'c', label: 'Gamma', icon: 'C', taskIds: [] },
  ];

  it('Right arrow moves selection to next phase', () => {
    const bar = new PhaseBar();
    bar.setPhases(phases);
    bar.setCurrentPhaseId('b');

    bar.handleInput(RIGHT_ARROW);
    const lines = bar.render(80);
    // After Right arrow, selectedPhaseId should be 'c' (Gamma)
    expect(lines[0]).toContain('\x1b[4m');
    // Gamma is pending (not current) so underline is directly on label
    expect(lines[0]).toContain('\x1b[4mGamma\x1b[0m');
  });

  it('Left arrow moves selection to previous phase', () => {
    const bar = new PhaseBar();
    bar.setPhases(phases);
    bar.setCurrentPhaseId('b');

    bar.handleInput(LEFT_ARROW);
    const lines = bar.render(80);
    // Alpha is current (running), so underline wraps bold: \x1b[4m\x1b[1mAlpha\x1b[0m\x1b[0m
    expect(lines[0]).toContain('\x1b[4m');
    expect(lines[0]).toContain('Alpha');
  });

  it('Right arrow wraps from last phase to first', () => {
    const bar = new PhaseBar();
    bar.setPhases(phases);
    bar.setCurrentPhaseId('c');

    bar.handleInput(RIGHT_ARROW);
    const lines = bar.render(80);
    // selectedPhaseId should be 'a' (wrap to first), also current, so bold+underline
    expect(lines[0]).toContain('\x1b[4m');
    expect(lines[0]).toContain('Alpha');
  });

  it('Left arrow wraps from first phase to last', () => {
    const bar = new PhaseBar();
    bar.setPhases(phases);
    bar.setCurrentPhaseId('a');

    bar.handleInput(LEFT_ARROW);
    const lines = bar.render(80);
    // selectedPhaseId should be 'c' (wrap to last), pending so direct underline
    expect(lines[0]).toContain('\x1b[4mGamma\x1b[0m');
  });

  it('handleInput is a no-op when phases are empty', () => {
    const bar = new PhaseBar();
    // No phases set
    expect(() => {
      bar.handleInput(RIGHT_ARROW);
      bar.handleInput(LEFT_ARROW);
    }).not.toThrow();
  });

  it('multiple Right arrows cycle through all phases', () => {
    const bar = new PhaseBar();
    bar.setPhases(phases);
    bar.setCurrentPhaseId('a');

    // Right: a→b (b is pending, so direct underline)
    bar.handleInput(RIGHT_ARROW);
    expect(bar.render(80)[0]).toContain('\x1b[4mBeta\x1b[0m');

    // Right: b→c
    bar.handleInput(RIGHT_ARROW);
    expect(bar.render(80)[0]).toContain('\x1b[4mGamma\x1b[0m');

    // Right: c→a (wrap, a is current so bold+underline)
    bar.handleInput(RIGHT_ARROW);
    const line = bar.render(80)[0];
    expect(line).toContain('\x1b[4m');
    expect(line).toContain('Alpha');
    // Gamma marker should be pending (·) and Gamma label dimmed
    expect(line).toContain('\x1b[2m·\x1b[0m');
    expect(line).toContain('\x1b[2mGamma\x1b[0m');
  });

  it('multiple Left arrows cycle backwards through all phases', () => {
    const bar = new PhaseBar();
    bar.setPhases(phases);
    bar.setCurrentPhaseId('c');

    // Left: c→b (b is pending, direct underline)
    bar.handleInput(LEFT_ARROW);
    expect(bar.render(80)[0]).toContain('\x1b[4mBeta\x1b[0m');

    // Left: b→a (a is pending, direct underline)
    bar.handleInput(LEFT_ARROW);
    expect(bar.render(80)[0]).toContain('\x1b[4mAlpha\x1b[0m');

    // Left: a→c (wrap, c is current so bold+underline)
    bar.handleInput(LEFT_ARROW);
    const line = bar.render(80)[0];
    expect(line).toContain('\x1b[4m');
    expect(line).toContain('Gamma');
  });

  it('Left and Right arrows interleave correctly', () => {
    const bar = new PhaseBar();
    bar.setPhases(phases);
    bar.setCurrentPhaseId('b');

    // Right: b→c (c is pending, direct underline)
    bar.handleInput(RIGHT_ARROW);
    expect(bar.render(80)[0]).toContain('\x1b[4mGamma\x1b[0m');

    // Left: c→b (b is current, bold+underline)
    bar.handleInput(LEFT_ARROW);
    const line1 = bar.render(80)[0];
    expect(line1).toContain('\x1b[4m');
    expect(line1).toContain('Beta');

    // Left: b→a (a is pending, direct underline)
    bar.handleInput(LEFT_ARROW);
    expect(bar.render(80)[0]).toContain('\x1b[4mAlpha\x1b[0m');

    // Right: a→b (b is current, bold+underline)
    bar.handleInput(RIGHT_ARROW);
    const line2 = bar.render(80)[0];
    expect(line2).toContain('\x1b[4m');
    expect(line2).toContain('Beta');
  });

  it('handleInput respects selectedPhaseId as starting point', () => {
    const bar = new PhaseBar();
    bar.setPhases(phases);
    bar.setCurrentPhaseId('a');
    bar.setSelectedPhase('c'); // start selection on 'c'

    // Right from 'c' should wrap to 'a' (a is current, bold+underline)
    bar.handleInput(RIGHT_ARROW);
    const lines = bar.render(80);
    expect(lines[0]).toContain('\x1b[4m');
    expect(lines[0]).toContain('Alpha');

    // Left from 'a' should wrap to 'c' (c is pending, direct underline)
    bar.handleInput(LEFT_ARROW);
    expect(bar.render(80)[0]).toContain('\x1b[4mGamma\x1b[0m');
  });

  it('handleInput busts the render cache', () => {
    const bar = new PhaseBar();
    bar.setPhases(phases);
    bar.setCurrentPhaseId('a');

    const first = bar.render(80);
    bar.handleInput(RIGHT_ARROW);
    const second = bar.render(80);

    expect(second).not.toBe(first);
  });

  it('non-arrow keys do not change selection', () => {
    const bar = new PhaseBar();
    bar.setPhases(phases);
    bar.setCurrentPhaseId('a');

    bar.handleInput('x');
    const lines = bar.render(80);
    // Should still have underline on 'a' (current, bold+underline)
    expect(lines[0]).toContain('\x1b[4m');
    expect(lines[0]).toContain('Alpha');

    bar.handleInput('\r');
    const lines2 = bar.render(80);
    expect(lines2[0]).toContain('\x1b[4m');
    expect(lines2[0]).toContain('Alpha');
  });

  it('handleInput on single-phase list does nothing', () => {
    const bar = new PhaseBar();
    bar.setPhases([{ id: 'only', label: 'Only', icon: 'O', taskIds: [] }]);
    bar.setCurrentPhaseId('only');

    bar.handleInput(RIGHT_ARROW);
    // Should still be on 'only' (current, bold+underline)
    const lines = bar.render(80);
    expect(lines[0]).toContain('\x1b[4m');
    expect(lines[0]).toContain('Only');

    bar.handleInput(LEFT_ARROW);
    const lines2 = bar.render(80);
    expect(lines2[0]).toContain('\x1b[4m');
    expect(lines2[0]).toContain('Only');
  });
});
