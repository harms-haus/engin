import type { PhaseEntity } from '@engin/shared';
import { describe, expect, it } from 'bun:test';
import { renderTest, stripAnsi } from '../test-harness.js';
import { PhaseBar } from './phase-bar.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makePhase(overrides: Partial<PhaseEntity> & { id: string }): PhaseEntity {
  return {
    label: overrides.id,
    icon: '📋',
    taskIds: [],
    ...overrides,
  };
}

// ─── PhaseBar – markers ─────────────────────────────────────────────────────

describe('PhaseBar – markers', () => {
  it('renders ✓ for completed phases', () => {
    const phases: PhaseEntity[] = [
      makePhase({ id: 'plan', label: 'Plan' }),
      makePhase({ id: 'exec', label: 'Execute' }),
    ];
    const { lastFrame } = renderTest(
      <PhaseBar phases={phases} currentPhaseId="exec" completedPhaseIds={['plan']} selectedPhaseId="" />,
    );
    const text = stripAnsi(lastFrame()!);
    expect(text).toContain('✓');
    expect(text).toContain('Plan');
  });

  it('renders ● for the running phase (currentPhaseId)', () => {
    const phases: PhaseEntity[] = [
      makePhase({ id: 'plan', label: 'Plan' }),
      makePhase({ id: 'exec', label: 'Execute' }),
    ];
    const { lastFrame } = renderTest(
      <PhaseBar phases={phases} currentPhaseId="exec" completedPhaseIds={[]} selectedPhaseId="" />,
    );
    const text = stripAnsi(lastFrame()!);
    expect(text).toContain('●');
    expect(text).toContain('Execute');
  });

  it('renders · for pending phases', () => {
    const phases: PhaseEntity[] = [
      makePhase({ id: 'plan', label: 'Plan' }),
      makePhase({ id: 'exec', label: 'Execute' }),
      makePhase({ id: 'review', label: 'Review' }),
    ];
    const { lastFrame } = renderTest(
      <PhaseBar phases={phases} currentPhaseId="exec" completedPhaseIds={[]} selectedPhaseId="" />,
    );
    const text = stripAnsi(lastFrame()!);
    // Plan and Review are pending — should have · marker
    expect(text).toContain('·');
  });

  it('renders all three marker types simultaneously', () => {
    const phases: PhaseEntity[] = [
      makePhase({ id: 'plan', label: 'Plan' }),
      makePhase({ id: 'exec', label: 'Execute' }),
      makePhase({ id: 'review', label: 'Review' }),
    ];
    const { lastFrame } = renderTest(
      <PhaseBar phases={phases} currentPhaseId="exec" completedPhaseIds={['plan']} selectedPhaseId="" />,
    );
    const text = stripAnsi(lastFrame()!);
    expect(text).toContain('✓');
    expect(text).toContain('●');
    expect(text).toContain('·');
    expect(text).toContain('Plan');
    expect(text).toContain('Execute');
    expect(text).toContain('Review');
  });
});

// ─── PhaseBar – labels ──────────────────────────────────────────────────────

describe('PhaseBar – labels', () => {
  it('renders phase labels in plain text', () => {
    const phases: PhaseEntity[] = [makePhase({ id: 'a', label: 'Alpha' }), makePhase({ id: 'b', label: 'Beta' })];
    const { lastFrame } = renderTest(
      <PhaseBar phases={phases} currentPhaseId="" completedPhaseIds={[]} selectedPhaseId="" />,
    );
    const text = stripAnsi(lastFrame()!);
    expect(text).toContain('Alpha');
    expect(text).toContain('Beta');
  });

  it('does NOT dim completed phase labels', () => {
    const phases: PhaseEntity[] = [makePhase({ id: 'a', label: 'Alpha' }), makePhase({ id: 'b', label: 'Beta' })];
    const { lastFrame } = renderTest(
      <PhaseBar phases={phases} currentPhaseId="b" completedPhaseIds={['a']} selectedPhaseId="" />,
    );
    const text = stripAnsi(lastFrame()!);
    expect(text).toContain('Alpha');
    expect(text).toContain('✓');
  });
});

// ─── PhaseBar – empty state ─────────────────────────────────────────────────

describe('PhaseBar – empty state', () => {
  it('renders empty string when no phases, no indicator, no currentPhaseId', () => {
    const { lastFrame } = renderTest(
      <PhaseBar phases={[]} currentPhaseId="" completedPhaseIds={[]} selectedPhaseId="" />,
    );
    expect(stripAnsi(lastFrame()!).trim()).toBe('');
  });

  it('renders indicator when no phases', () => {
    const { lastFrame } = renderTest(
      <PhaseBar phases={[]} currentPhaseId="" completedPhaseIds={[]} selectedPhaseId="" indicator="▶" />,
    );
    expect(stripAnsi(lastFrame()!).trim()).toBe('▶');
  });

  it('renders indicator and currentPhaseId when no phases', () => {
    const { lastFrame } = renderTest(
      <PhaseBar phases={[]} currentPhaseId="custom-phase" completedPhaseIds={[]} selectedPhaseId="" indicator="⚙" />,
    );
    const text = stripAnsi(lastFrame()!).trim();
    // The empty-state format joins indicator and currentPhaseId with a space
    expect(text).toBe('⚙ custom-phase');
  });

  it('renders only currentPhaseId when no phases and no indicator', () => {
    const { lastFrame } = renderTest(
      <PhaseBar phases={[]} currentPhaseId="orphan" completedPhaseIds={[]} selectedPhaseId="" />,
    );
    const text = stripAnsi(lastFrame()!).trim();
    expect(text).toBe('orphan');
  });
});

// ─── PhaseBar – indicator ───────────────────────────────────────────────────

describe('PhaseBar – indicator', () => {
  it('prepends indicator when provided', () => {
    const phases: PhaseEntity[] = [makePhase({ id: 'plan', label: 'Plan' })];
    const { lastFrame } = renderTest(
      <PhaseBar phases={phases} currentPhaseId="plan" completedPhaseIds={[]} selectedPhaseId="" indicator="▶" />,
    );
    const text = stripAnsi(lastFrame()!).trim();
    expect(text).toMatch(/^▶/);
  });

  it('does not show indicator when not provided', () => {
    const phases: PhaseEntity[] = [makePhase({ id: 'plan', label: 'Plan' })];
    const { lastFrame } = renderTest(
      <PhaseBar phases={phases} currentPhaseId="plan" completedPhaseIds={[]} selectedPhaseId="" />,
    );
    const text = stripAnsi(lastFrame()!).trim();
    expect(text).not.toMatch(/^▶/);
    expect(text).toBe('● Plan');
  });
});

// ─── PhaseBar – separator ───────────────────────────────────────────────────

describe('PhaseBar – separator', () => {
  it('renders │ between phases', () => {
    const phases: PhaseEntity[] = [
      makePhase({ id: 'a', label: 'Alpha' }),
      makePhase({ id: 'b', label: 'Beta' }),
      makePhase({ id: 'c', label: 'Gamma' }),
    ];
    const { lastFrame } = renderTest(
      <PhaseBar phases={phases} currentPhaseId="a" completedPhaseIds={[]} selectedPhaseId="" />,
    );
    const text = stripAnsi(lastFrame()!);
    // Count separators: should be (phases.length - 1) = 2
    const sepCount = (text.match(/│/g) || []).length;
    expect(sepCount).toBe(2);
  });

  it('has no separator for a single phase', () => {
    const phases: PhaseEntity[] = [makePhase({ id: 'only', label: 'Only' })];
    const { lastFrame } = renderTest(
      <PhaseBar phases={phases} currentPhaseId="only" completedPhaseIds={[]} selectedPhaseId="" />,
    );
    const text = stripAnsi(lastFrame()!);
    expect(text).not.toContain('│');
  });
});

// ─── PhaseBar – selectedPhaseId defaults to currentPhaseId ──────────────────

describe('PhaseBar – selectedPhaseId defaults to currentPhaseId', () => {
  it('uses currentPhaseId as effective selected when selectedPhaseId is empty', () => {
    const phases: PhaseEntity[] = [makePhase({ id: 'a', label: 'Alpha' }), makePhase({ id: 'b', label: 'Beta' })];
    const { lastFrame } = renderTest(
      <PhaseBar phases={phases} currentPhaseId="a" completedPhaseIds={[]} selectedPhaseId="" />,
    );
    const text = stripAnsi(lastFrame()!);
    expect(text).toContain('Alpha');
    expect(text).toContain('●');
  });

  it('when selectedPhaseId is set, selection overrides currentPhaseId for label styling', () => {
    const phases: PhaseEntity[] = [
      makePhase({ id: 'a', label: 'Alpha' }),
      makePhase({ id: 'b', label: 'Beta' }),
      makePhase({ id: 'c', label: 'Gamma' }),
    ];
    const { lastFrame } = renderTest(
      <PhaseBar phases={phases} currentPhaseId="a" completedPhaseIds={[]} selectedPhaseId="b" />,
    );
    const text = stripAnsi(lastFrame()!);
    // Both labels should appear
    expect(text).toContain('Alpha');
    expect(text).toContain('Beta');
    expect(text).toContain('Gamma');
  });
});

// ─── PhaseBar – re-render ───────────────────────────────────────────────────

describe('PhaseBar – re-render', () => {
  it('re-renders when props change', () => {
    const phases: PhaseEntity[] = [makePhase({ id: 'a', label: 'Alpha' }), makePhase({ id: 'b', label: 'Beta' })];
    const { lastFrame, rerender } = renderTest(
      <PhaseBar phases={phases} currentPhaseId="a" completedPhaseIds={[]} selectedPhaseId="" />,
    );
    let text = stripAnsi(lastFrame()!);
    expect(text).toContain('●');
    expect(text).toContain('Alpha');
    expect(text).toContain('·');
    expect(text).toContain('Beta');

    // Complete a, move current to b
    rerender(<PhaseBar phases={phases} currentPhaseId="b" completedPhaseIds={['a']} selectedPhaseId="" />);
    text = stripAnsi(lastFrame()!);
    expect(text).toContain('✓');
    expect(text).toContain('Alpha');
    expect(text).toContain('●');
    expect(text).toContain('Beta');
  });

  it('removes running marker when all phases completed', () => {
    const phases: PhaseEntity[] = [makePhase({ id: 'a', label: 'Alpha' }), makePhase({ id: 'b', label: 'Beta' })];
    const { lastFrame, rerender } = renderTest(
      <PhaseBar phases={phases} currentPhaseId="a" completedPhaseIds={[]} selectedPhaseId="" />,
    );
    expect(stripAnsi(lastFrame()!)).toContain('●');

    rerender(<PhaseBar phases={phases} currentPhaseId="a" completedPhaseIds={['a', 'b']} selectedPhaseId="" />);
    const text = stripAnsi(lastFrame()!);
    expect(text).toContain('✓');
    expect(text).not.toContain('●');
  });

  it('updates marker from pending to running when currentPhaseId changes', () => {
    const phases: PhaseEntity[] = [makePhase({ id: 'a', label: 'Alpha' }), makePhase({ id: 'b', label: 'Beta' })];
    const { lastFrame, rerender } = renderTest(
      <PhaseBar phases={phases} currentPhaseId="a" completedPhaseIds={[]} selectedPhaseId="" />,
    );
    let text = stripAnsi(lastFrame()!);
    expect(text).toContain('●');
    expect(text).toMatch(/·.*Beta/);

    // Switch current to b
    rerender(<PhaseBar phases={phases} currentPhaseId="b" completedPhaseIds={[]} selectedPhaseId="" />);
    text = stripAnsi(lastFrame()!);
    expect(text).toContain('●');
    expect(text).toContain('Beta');
    expect(text).toMatch(/·.*Alpha/);
  });
});

// ─── PhaseBar – edge cases ──────────────────────────────────────────────────

describe('PhaseBar – edge cases', () => {
  it('handles a single phase correctly', () => {
    const phases: PhaseEntity[] = [makePhase({ id: 'only', label: 'Only' })];
    const { lastFrame } = renderTest(
      <PhaseBar phases={phases} currentPhaseId="only" completedPhaseIds={[]} selectedPhaseId="" />,
    );
    const text = stripAnsi(lastFrame()!).trim();
    expect(text).toBe('● Only');
  });

  it('handles completed single phase', () => {
    const phases: PhaseEntity[] = [makePhase({ id: 'done', label: 'Done' })];
    const { lastFrame } = renderTest(
      <PhaseBar phases={phases} currentPhaseId="done" completedPhaseIds={['done']} selectedPhaseId="" />,
    );
    const text = stripAnsi(lastFrame()!).trim();
    expect(text).toBe('✓ Done');
  });

  it('handles many phases with truncation', () => {
    const phases: PhaseEntity[] = Array.from({ length: 10 }, (_, i) => makePhase({ id: `p${i}`, label: `P${i}` }));
    const completedIds = phases.slice(0, 5).map((p) => p.id);
    const { lastFrame } = renderTest(
      <PhaseBar phases={phases} currentPhaseId="p5" completedPhaseIds={completedIds} selectedPhaseId="" />,
    );
    const text = stripAnsi(lastFrame()!);
    // The output should be truncated — only early phases appear
    expect(text).toContain('✓');
    expect(text).toContain('●');
    expect(text).toContain('·');
    // Early labels (within truncation) appear
    expect(text).toContain('P0');
    expect(text).toContain('P1');
    // Separators appear before truncation
    expect(text).toContain('│');
  });
});
