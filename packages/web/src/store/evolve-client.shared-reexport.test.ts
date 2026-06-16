/**
 * Web migration verification: evolve-client → @engin/shared/evolve.
 *
 * `web/src/store/evolve-client.ts` is a thin re-export layer. After the
 * migration its sole line becomes:
 *
 *   export { MAX_AGENT_LOG, evolve as evolveClient } from '@engin/shared/evolve';
 *
 * (previously sourced from '@engin/tracking/evolve'). The engine-side
 * `src/tracking/evolve.ts` is itself now a backward-compat shim that re-exports
 * from `@engin/shared/evolve`, so both the old and new web import paths resolve
 * to the same shared module. This suite pins that contract from the web app's
 * perspective.
 *
 * It proves the move is behaviour-preserving by:
 *
 *   1. Importing `evolve` + `MAX_AGENT_LOG` directly from @engin/shared/evolve
 *      (the new canonical home).
 *   2. Importing `evolveClient` + `MAX_AGENT_LOG` from the web re-export layer
 *      and asserting they are the IDENTICAL runtime binding (===) — proving the
 *      web module is a true re-export of the shared package, not a copy.
 *   3. A behaviour smoke-test feeding a representative event sequence through
 *      the shared `evolve` and asserting the projection is correct.
 */

import { describe, expect, it } from 'vitest';

// ── NEW canonical home: shared package ──────────────────────────────────────
import type { EventRecord, EventType, WorkflowProjection } from '@engin/shared/event-types';
import { createInitialProjection } from '@engin/shared/event-types';
import { evolve, MAX_AGENT_LOG } from '@engin/shared/evolve';

// ── Web re-export layer (the module under migration) ────────────────────────
import { MAX_AGENT_LOG as clientMAX_AGENT_LOG, evolveClient } from './evolve-client';

// ── Helpers ──────────────────────────────────────────────────────────────────

let seq = 0;
function ev(
  type: EventType,
  data: Record<string, unknown> = {},
  metadata: EventRecord['metadata'] = { timestamp: '2026-06-15T00:00:00Z' },
): EventRecord {
  return { seq: ++seq, type, data, metadata };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('evolve-client — binds the SAME evolve as @engin/shared/evolve', () => {
  it('evolveClient is the identical binding as @engin/shared evolve (===)', () => {
    // === proves the web module does `export { evolve as evolveClient } from
    // '@engin/shared/evolve'` rather than re-declaring its own copy.
    expect(evolveClient).toBe(evolve);
    expect(typeof evolveClient).toBe('function');
  });

  it('MAX_AGENT_LOG is the identical value as @engin/shared MAX_AGENT_LOG (===)', () => {
    expect(clientMAX_AGENT_LOG).toBe(MAX_AGENT_LOG);
    expect(clientMAX_AGENT_LOG).toBe(500);
    expect(typeof clientMAX_AGENT_LOG).toBe('number');
  });
});

describe('evolve-client — behaviour smoke test against @engin/shared/evolve', () => {
  it('evolve is pure/immutable (returns a new object)', () => {
    seq = 0;
    const state = createInitialProjection();
    const next = evolve(state, ev('workflow_started', { taskPrompt: 'hello' }));
    expect(next).not.toBe(state);
    expect(next.taskPrompt).toBe('hello');
    expect(next.status).toBe('running');
  });

  it('drives a representative workflow_started → phase → task → agent → complete sequence', () => {
    seq = 0;
    let state = createInitialProjection();
    state = evolve(state, ev('workflow_started', { taskPrompt: 'Build it' }));
    state = evolve(state, ev('phase_registered', { id: 'p1', label: 'Phase 1', icon: '🔧' }));
    state = evolve(state, ev('phase_started', { phase: 'p1' }, { timestamp: 't', phaseId: 'p1' }));
    state = evolve(
      state,
      ev('task_registered', {
        taskId: 't1',
        title: 'Do thing',
        phaseId: 'p1',
        steps: [{ name: 'implement', profileId: 'coder', isReadOnly: false }],
        dependencies: [],
      }),
    );
    state = evolve(state, ev('agent_spawned', { profile: 'coder' }, { timestamp: 't', agentId: 'a1', taskId: 't1' }));
    state = evolve(state, ev('phase_completed', { phase: 'p1' }));
    state = evolve(state, ev('workflow_completed', { totalDurationMs: 1000 }));

    const projection: WorkflowProjection = state;
    expect(projection.status).toBe('complete');
    expect(projection.completedPhaseIds).toEqual(['p1']);
    expect(projection.phases[0].taskIds).toEqual(['t1']);
    expect(projection.agents['a1::t1']).toBeDefined();
    expect(projection.stats.agentCount).toBe(1);
    expect(projection.seq).toBe(7);
  });

  it('evolveClient and evolve produce identical output for the same inputs', () => {
    seq = 0;
    const viaClient = evolveClient(createInitialProjection(), ev('workflow_started', { taskPrompt: 'x' }));
    seq = 0;
    const viaShared = evolve(createInitialProjection(), ev('workflow_started', { taskPrompt: 'x' }));
    expect(viaClient).toEqual(viaShared);
  });
});
