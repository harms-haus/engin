// ─── Integration: PhaseRunner → onStatus → EventStore → projection ──────────
//
// D6 verifies that the PhaseRunner emits phase state PURELY via onStatus →
// EventStore events (single-writer). The runner still mutates the
// WorkflowStatusTracker for its own internal bookkeeping (transitions,
// persistence), but the PROJECTION must learn about phase registrations,
// phase starts, and phase completions from EVENTS appended through the
// `onStatus` surface — not from direct tracker reads.
//
// This test wires a REAL EventStore + createStoreCallbacks as the runner's
// `onStatus`, runs the runner, then asserts the store's projection reflects
// the full phase lifecycle: registered phases, currentPhaseId progression,
// and completedPhaseIds — all derived from events alone.

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { PhaseDefinition, PhaseRunnerOptions } from '../../packages/engine/src/core/phase-runner.js';
import { PhaseRunner } from '../../packages/engine/src/core/phase-runner.js';
import { EventStore } from '../../packages/engine/src/tracking/event-store.js';
import { createStoreCallbacks } from '../../packages/engine/src/tracking/store-callbacks.js';
import { WorkflowStatusTracker } from '../../packages/engine/src/tracking/workflow-status.js';

// ── Fixture helpers ─────────────────────────────────────────────────────────

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = join(tmpdir(), `phase-runner-events-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(dir, { recursive: true });
  tempDirs.push(dir);
  return dir;
}

let dir: string;
let store: EventStore;
let tracker: WorkflowStatusTracker;

beforeEach(async () => {
  dir = await makeTempDir();
  store = new EventStore(dir);
  tracker = new WorkflowStatusTracker(dir);
});

afterEach(async () => {
  tracker.dispose();
  await store.flush();
  store.dispose();
  while (tempDirs.length) {
    const d = tempDirs.pop()!;
    await rm(d, { recursive: true, force: true }).catch(() => {});
  }
});

function makePhase(
  overrides: Partial<Omit<PhaseDefinition, 'run'>> & { run?: PhaseDefinition['run'] } = {},
): PhaseDefinition {
  return {
    id: 'phase',
    label: 'Phase',
    icon: '🔹',
    run: async () => 'done',
    ...overrides,
  };
}

function makeOptions(overrides: Partial<PhaseRunnerOptions> & { phases: PhaseDefinition[] }): PhaseRunnerOptions {
  return {
    tracker,
    cwd: dir,
    workDir: dir,
    onStatus: createStoreCallbacks(store),
    ...overrides,
  };
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('PhaseRunner → onStatus → EventStore → projection', () => {
  it('projection reflects registered phases from phase_registered events', async () => {
    const phases: PhaseDefinition[] = [
      makePhase({ id: 'A', label: 'Alpha', icon: '🅰️' }),
      makePhase({ id: 'B', label: 'Bravo', icon: '🅱️' }),
    ];

    await new PhaseRunner(makeOptions({ phases })).run();

    const projection = store.getProjection();
    expect(projection.phases.map((p) => p.id)).toEqual(['A', 'B']);
    expect(projection.phases.map((p) => p.label)).toEqual(['Alpha', 'Bravo']);
    expect(projection.phases.map((p) => p.icon)).toEqual(['🅰️', '🅱️']);
  });

  it('projection reflects phase_started → currentPhaseId progression', async () => {
    const phases: PhaseDefinition[] = [
      makePhase({ id: 'scouting', label: 'Scouting', icon: '🔍' }),
      makePhase({ id: 'planning', label: 'Planning', icon: '📋' }),
    ];

    await new PhaseRunner(makeOptions({ phases })).run();

    const projection = store.getProjection();
    // The last phase_started event sets currentPhaseId to the final phase.
    expect(projection.currentPhaseId).toBe('planning');
  });

  it('projection reflects phase_completed → completedPhaseIds', async () => {
    const phases: PhaseDefinition[] = [
      makePhase({ id: 'A', label: 'Alpha', icon: '🅰️' }),
      makePhase({ id: 'B', label: 'Bravo', icon: '🅱️' }),
      makePhase({ id: 'C', label: 'Charlie', icon: '🅲' }),
    ];

    await new PhaseRunner(makeOptions({ phases })).run();

    const projection = store.getProjection();
    // Each phase fires a phase_completed event; the last phase (C) is current
    // but NOT in completedPhaseIds (its completion event fires but the
    // phase_completed handler pushes the phase from the event data, and
    // PhaseRunner fires onPhaseComplete for C too). All three phases should
    // appear in completedPhaseIds since the runner fires onPhaseComplete for
    // every phase including the last one.
    expect(projection.completedPhaseIds).toEqual(['A', 'B', 'C']);
  });

  it('a skipped phase still emits phase_started and phase_completed events', async () => {
    const phases: PhaseDefinition[] = [
      makePhase({
        id: 'A',
        run: async () => {},
      }),
      makePhase({
        id: 'B',
        run: async () => {},
      }),
      makePhase({
        id: 'C',
        run: async () => {},
      }),
    ];

    // Use the hook registry to skip phase B.
    const { createHookRegistry } = await import('../../packages/engine/src/hooks/registry.js');
    const registry = createHookRegistry();
    registry.register({
      beforePhase: (args: { phaseId: string }) => (args.phaseId === 'B' ? { skip: true } : undefined),
    });

    await new PhaseRunner(makeOptions({ phases, hookRegistry: registry })).run();

    const projection = store.getProjection();
    // Phase B was registered, started, and completed even though its run()
    // was skipped — the projection reflects the full lifecycle from events.
    expect(projection.phases.map((p) => p.id)).toEqual(['A', 'B', 'C']);
    expect(projection.completedPhaseIds).toContain('B');
    expect(projection.currentPhaseId).toBe('C');
  });

  it('onPhaseStart carries round=1 for the first run', async () => {
    const phases: PhaseDefinition[] = [makePhase({ id: 'A', label: 'Alpha', icon: '🅰️' })];

    await new PhaseRunner(makeOptions({ phases })).run();

    const phaseStartEvents = store.getEventsSince(0).filter((e) => e.type === 'phase_started');
    expect(phaseStartEvents.length).toBeGreaterThanOrEqual(1);
    expect(phaseStartEvents[0].data.round).toBe(1);
    expect(phaseStartEvents[0].data.phase).toBe('A');
  });

  it('onPhaseComplete carries a non-negative durationMs', async () => {
    const phases: PhaseDefinition[] = [makePhase({ id: 'A', label: 'Alpha', icon: '🅰️' })];

    await new PhaseRunner(makeOptions({ phases })).run();

    const completeEvents = store.getEventsSince(0).filter((e) => e.type === 'phase_completed');
    expect(completeEvents).toHaveLength(1);
    expect(completeEvents[0].data.phase).toBe('A');
    expect(typeof completeEvents[0].data.durationMs).toBe('number');
    expect(completeEvents[0].data.durationMs as number).toBeGreaterThanOrEqual(0);
  });

  it('full projection reflects phase/task/workflow state purely from events', async () => {
    // End-to-end: a 3-phase run where each phase registers a task. The
    // projection should reflect ALL phase lifecycle state from events alone.
    const phases: PhaseDefinition[] = [
      makePhase({
        id: 'scout',
        label: 'Scouting',
        icon: '🔍',
        run: async () => {
          tracker.taskTracker.addTask({
            id: 't1',
            title: 'scout-task',
            prompt: 'p',
            profile: 'scout',
            files: [],
            dependencies: [],
            phaseId: 'scout',
            worktree: 'none',
            status: 'complete',
            result: { found: 'stuff' },
          });
        },
      }),
      makePhase({
        id: 'plan',
        label: 'Planning',
        icon: '📋',
        run: async () => {},
      }),
    ];

    await new PhaseRunner(makeOptions({ phases })).run();

    const projection = store.getProjection();
    // Phases registered from events.
    expect(projection.phases.map((p) => p.id)).toEqual(['scout', 'plan']);
    // Current phase is the last one.
    expect(projection.currentPhaseId).toBe('plan');
    // Scout completed.
    expect(projection.completedPhaseIds).toEqual(['scout', 'plan']);
    // Workflow status is still 'running' (PhaseRunner does NOT own
    // workflow_started / workflow_completed — those are fired by the engine's
    // run-executor / workflow module). This confirms the runner only owns
    // phase-level events.
    expect(projection.status).toBe('running');
  });
});
