import { describe, expect, it } from 'bun:test';
import type { WorkflowPhase, WorkflowStatusCallbacks } from '../../src/core/types.js';

describe('WorkflowStatusCallbacks', () => {
  // ── onPhaseStart accepts string phase (backward-compatible) ────────
  describe('onPhaseStart', () => {
    it('accepts a standard WorkflowPhase as phase', () => {
      const cb: WorkflowStatusCallbacks = {
        onPhaseStart: (info) => {
          expect(info.phase).toBe('implementing');
          expect(info.round).toBe(1);
        },
      };
      cb.onPhaseStart!({ phase: 'implementing', round: 1 });
    });

    it('accepts a custom phase string not in WorkflowPhase union', () => {
      const cb: WorkflowStatusCallbacks = {
        onPhaseStart: (info) => {
          expect(info.phase).toBe('initialization');
          expect(info.round).toBe(0);
        },
      };
      // 'initialization' is not a WorkflowPhase value, but should be accepted
      cb.onPhaseStart!({ phase: 'initialization', round: 0 });
    });

    it('accepts any arbitrary string for phase', () => {
      const cb: WorkflowStatusCallbacks = {
        onPhaseStart: (info) => {
          expect(info.phase).toBe('custom_phase_42');
          expect(info.round).toBe(3);
        },
      };
      cb.onPhaseStart!({ phase: 'custom_phase_42', round: 3 });
    });
  });

  // ── onPhaseComplete accepts string phase (backward-compatible) ─────
  describe('onPhaseComplete', () => {
    it('accepts a standard WorkflowPhase as phase', () => {
      const cb: WorkflowStatusCallbacks = {
        onPhaseComplete: (info) => {
          expect(info.phase).toBe('planning');
          expect(info.durationMs).toBeGreaterThan(0);
        },
      };
      cb.onPhaseComplete!({ phase: 'planning', durationMs: 1500 });
    });

    it('accepts a custom phase string not in WorkflowPhase union', () => {
      const cb: WorkflowStatusCallbacks = {
        onPhaseComplete: (info) => {
          expect(info.phase).toBe('deploying');
          expect(info.durationMs).toBe(42_000);
        },
      };
      cb.onPhaseComplete!({ phase: 'deploying', durationMs: 42_000 });
    });

    it('accepts any arbitrary string for phase', () => {
      const cb: WorkflowStatusCallbacks = {
        onPhaseComplete: (info) => {
          expect(info.phase).toBe('phase_custom');
          expect(info.durationMs).toBe(0);
        },
      };
      cb.onPhaseComplete!({ phase: 'phase_custom', durationMs: 0 });
    });
  });

  // ── onSidebarUpdate (new callback) ─────────────────────────────────
  describe('onSidebarUpdate', () => {
    it('is optional and can be omitted', () => {
      const cb: WorkflowStatusCallbacks = {};
      expect(cb.onSidebarUpdate).toBeUndefined();
    });

    it('accepts info with all fields provided', () => {
      const cb: WorkflowStatusCallbacks = {
        onSidebarUpdate: (info) => {
          expect(info.title).toBe('My Workflow');
          expect(info.indicator).toBe('running');
          expect(info.phases).toHaveLength(3);
          expect(info.phases![0].id).toBe('scout');
          expect(info.phases![0].label).toBe('Scouting');
          expect(info.phases![0].icon).toBe('🔍');
        },
      };
      cb.onSidebarUpdate!({
        title: 'My Workflow',
        indicator: 'running',
        phases: [
          { id: 'scout', label: 'Scouting', icon: '🔍' },
          { id: 'plan', label: 'Planning', icon: '📋' },
          { id: 'implement', label: 'Implementing', icon: '⚙️' },
        ],
      });
    });

    it('accepts info with only title', () => {
      const cb: WorkflowStatusCallbacks = {
        onSidebarUpdate: (info) => {
          expect(info.title).toBe('Minimal Update');
          expect(info.indicator).toBeUndefined();
          expect(info.phases).toBeUndefined();
        },
      };
      cb.onSidebarUpdate!({ title: 'Minimal Update' });
    });

    it('accepts info with only indicator', () => {
      const cb: WorkflowStatusCallbacks = {
        onSidebarUpdate: (info) => {
          expect(info.title).toBeUndefined();
          expect(info.indicator).toBe('error');
          expect(info.phases).toBeUndefined();
        },
      };
      cb.onSidebarUpdate!({ indicator: 'error' });
    });

    it('accepts info with only phases', () => {
      const cb: WorkflowStatusCallbacks = {
        onSidebarUpdate: (info) => {
          expect(info.title).toBeUndefined();
          expect(info.indicator).toBeUndefined();
          expect(info.phases).toHaveLength(1);
          expect(info.phases![0]).toEqual({ id: 'done', label: 'Done', icon: '✅' });
        },
      };
      cb.onSidebarUpdate!({ phases: [{ id: 'done', label: 'Done', icon: '✅' }] });
    });

    it('accepts empty phases array', () => {
      const cb: WorkflowStatusCallbacks = {
        onSidebarUpdate: (info) => {
          expect(info.phases).toEqual([]);
        },
      };
      cb.onSidebarUpdate!({ phases: [] });
    });

    it('accepts an empty info object (all fields optional)', () => {
      const cb: WorkflowStatusCallbacks = {
        onSidebarUpdate: (_info) => {
          // All fields are optional, so empty object is valid
        },
      };
      cb.onSidebarUpdate!({});
    });
  });

  // ── All callbacks can be combined ──────────────────────────────────
  it('can define onPhaseStart, onPhaseComplete, and onSidebarUpdate together', () => {
    const phases: string[] = [];
    const cb: WorkflowStatusCallbacks = {
      onPhaseStart: (info) => {
        phases.push(`start:${info.phase}`);
      },
      onPhaseComplete: (info) => {
        phases.push(`complete:${info.phase}`);
      },
      onSidebarUpdate: (info) => {
        if (info.title) phases.push(`sidebar:${info.title}`);
      },
    };

    cb.onPhaseStart!({ phase: 'scouting', round: 1 });
    cb.onSidebarUpdate!({ title: 'Workflow Running' });
    cb.onPhaseComplete!({ phase: 'scouting', durationMs: 500 });

    expect(phases).toEqual(['start:scouting', 'sidebar:Workflow Running', 'complete:scouting']);
  });

  // ── Backward compatibility: WorkflowPhase values still work ────────
  it('all standard WorkflowPhase values are assignable to phase strings', () => {
    const allPhases: WorkflowPhase[] = [
      'scouting',
      'scouting_review',
      'planning',
      'plan_review',
      'implementing',
      'final_review',
      'done',
    ];

    const cb: WorkflowStatusCallbacks = {
      onPhaseStart: (info) => {
        expect(allPhases).toContain(info.phase as WorkflowPhase);
      },
      onPhaseComplete: (info) => {
        expect(allPhases).toContain(info.phase as WorkflowPhase);
      },
    };

    for (const phase of allPhases) {
      cb.onPhaseStart!({ phase, round: 1 });
      cb.onPhaseComplete!({ phase, durationMs: 100 });
    }
  });
});
