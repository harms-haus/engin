// ─── Move verification: evolve → @engin/shared/evolve ────────────────────────
//
// After the refactor, `evolve.ts` physically lives in
// packages/shared/src/evolve.ts and is consumed via `@engin/shared/evolve`.
// The OLD path src/tracking/evolve.ts is kept as a backward-compat shim that
// re-exports ONLY the two public exports — `evolve` and `MAX_AGENT_LOG` — from
// the shared package. All existing consumers (src/index.ts barrel,
// web/src/store/evolve-client.ts, tests/tracking/evolve.test.ts) keep working
// unchanged via the shim.
//
// This suite proves the move is behaviour-preserving by:
//
//   1. Importing evolve + MAX_AGENT_LOG directly from @engin/shared/evolve and
//      asserting presence/shape (the "new canonical home").
//   2. Importing the same two exports from the OLD shim path and asserting they
//      are the IDENTICAL runtime binding (===) — proving the shim is a true
//      re-export, not a re-declaration.
//   3. A behaviour smoke-test: feeding a representative event sequence through
//      the shared-package `evolve` and asserting the projection is correct.
//   4. Confirming the internal helpers (agentKey, resolveAgent, clone) remain
//      unexported by both the shared module and the shim.
//

import { describe, expect, it } from 'bun:test';

// ── NEW canonical home: shared package ──────────────────────────────────────
import type { EventRecord, EventType } from '@engin/shared/event-types';
import { createInitialProjection } from '@engin/shared/event-types';
import { MAX_AGENT_LOG, evolve } from '@engin/shared/evolve';

// ── OLD backward-compat shim path ───────────────────────────────────────────
import { evolve as shimEvolve, MAX_AGENT_LOG as shimMAX_AGENT_LOG } from '../../packages/engine/src/tracking/evolve.js';

// ── Type-level exact-equality utility (mirrors tests/core/types.test.ts) ────

type Equal<X, Y> = (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2 ? true : false;

function assertEqual<T extends true>(_desc?: string): void {}

// The shim's evolve signature must match the shared module's.
assertEqual<Equal<typeof shimEvolve, typeof evolve>>('shim evolve signature === shared evolve signature');

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

describe('@engin/shared/evolve — canonical exports', () => {
  it('exports evolve as a function', () => {
    expect(typeof evolve).toBe('function');
  });

  it('exports MAX_AGENT_LOG equal to 500', () => {
    expect(MAX_AGENT_LOG).toBe(500);
    expect(typeof MAX_AGENT_LOG).toBe('number');
  });

  it('evolve is pure/immutable (returns a new object)', () => {
    seq = 0;
    const state = createInitialProjection();
    const next = evolve(state, ev('workflow_started', { taskPrompt: 'hello' }));
    expect(next).not.toBe(state);
    expect(next.taskPrompt).toBe('hello');
    expect(next.status).toBe('running');
  });

  it('evolve drives a representative phase→task→agent→complete sequence', () => {
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
    state = evolve(
      state,
      ev('agent_spawned', { agentId: 'a1', profile: 'coder' }, { timestamp: 't', agentId: 'a1', taskId: 't1' }),
    );
    state = evolve(state, ev('phase_completed', { phase: 'p1' }));
    state = evolve(state, ev('workflow_completed', { totalDurationMs: 1000 }));

    expect(state.status).toBe('complete');
    expect(state.completedPhaseIds).toEqual(['p1']);
    expect(state.phases[0].taskIds).toEqual(['t1']);
    expect(state.agents['a1::t1']).toBeDefined();
    expect(state.stats.agentCount).toBe(1);
  });
});

describe('src/tracking/evolve shim — re-exports from @engin/shared/evolve', () => {
  it('re-exports the SAME evolve binding (identity)', () => {
    // === proves the shim does `export { evolve } from '@engin/shared/evolve'`
    expect(shimEvolve).toBe(evolve);
  });

  it('re-exports the SAME MAX_AGENT_LOG value (identity)', () => {
    expect(shimMAX_AGENT_LOG).toBe(MAX_AGENT_LOG);
    expect(shimMAX_AGENT_LOG).toBe(500);
  });

  it('shim evolve behaves identically to shared evolve for a no-op event', () => {
    seq = 0;
    const state = createInitialProjection();
    const viaShim = shimEvolve(state, ev('workflow_started', { taskPrompt: 'x' }));
    seq = 0;
    const viaShared = evolve(createInitialProjection(), ev('workflow_started', { taskPrompt: 'x' }));
    expect(viaShim).toEqual(viaShared);
  });
});

describe('export surface — only public symbols are exported', () => {
  it('the shared module exports only evolve + MAX_AGENT_LOG (internal helpers stay private)', async () => {
    // agentKey, resolveAgent, clone are module-private and must remain so.
    const mod = (await import('@engin/shared/evolve')) as Record<string, unknown>;
    expect(mod.evolve).toBe(evolve);
    expect(mod.MAX_AGENT_LOG).toBe(MAX_AGENT_LOG);
    expect(mod.agentKey).toBeUndefined();
    expect(mod.resolveAgent).toBeUndefined();
    expect(mod.clone).toBeUndefined();
  });

  it('the shim exports only evolve + MAX_AGENT_LOG (internal helpers stay private)', async () => {
    const mod = (await import('../../packages/engine/src/tracking/evolve.js')) as Record<string, unknown>;
    expect(mod.evolve).toBe(evolve);
    expect(mod.MAX_AGENT_LOG).toBe(MAX_AGENT_LOG);
    expect(mod.agentKey).toBeUndefined();
    expect(mod.resolveAgent).toBeUndefined();
    expect(mod.clone).toBeUndefined();
  });
});
