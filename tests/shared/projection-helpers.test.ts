// ────────────────────────────────────────────────────────────────────────────
// projection-helpers tests — shared store helpers extracted from ClientStore
// (packages/shared/src/client-store.ts) and web workflow-store
// (packages/web/src/store/workflow-store.ts).
//
// Both stores duplicate four helper functions:
//
//   • capAgentLogs(agents)
//   • toProjection(state)              — reconstruct a WorkflowProjection
//   • writeProjectionToState(state, p) — write projection fields into state
//   • reconcileSelection(state)        — phase / task / step follow rules
//
// These tests pin the contract for the new shared module
// `packages/shared/src/projection-helpers.ts`, which exposes generic,
// framework-free versions of all four. The behaviors are derived DIRECTLY
// from the current ClientStore implementation (the canonical copy being
// extracted in this task), so the extraction is behavior-preserving.
//
// ── CONTRACT ASSUMPTIONS (the implementation must satisfy these) ───────────
//
// The module is imported via the package subpath alias:
//
//   import {
//     capAgentLogs,
//     toProjection,
//     writeProjectionToState,
//     reconcileSelection,
//   } from '@engin/shared/projection-helpers';
//
// All four helpers use the CANONICAL projection field names (`tasks`,
// `agents`, …) — NOT the web store's `tasksById` / `agentsById`. The web
// store (refactored separately in task-15) maps its fields onto the canonical
// names before calling these helpers.
//
//   export function capAgentLogs(
//     agents: Record<string, AgentEntity>,
//   ): Record<string, AgentEntity>;
//
//   // Accepts an object carrying the projection fields (canonical names) and
//   // returns a WorkflowProjection whose `runLog` is reset to a fresh empty
//   // array — the seed for an evolve fold.
//   export function toProjection(fields: ProjectionFields): WorkflowProjection;
//
//   // Writes every normalized projection field into `state` (defensive shallow
//   // copies for collections). Does NOT write `seq` or `runLog`.
//   // `fromSnapshot` (default false): when true, defensively caps agent logs
//   // (untrusted external source); when false, passes agents through uncapped
//   // (the event-folding path — evolve already enforces the cap).
//   export function writeProjectionToState(
//     state: WritableProjectionState,
//     p: WorkflowProjection,
//     fromSnapshot?: boolean,
//   ): void;
//
//   // Phase / task / step follow rules. Mutates selection fields on `state`.
//   export function reconcileSelection(state: SelectionState): void;
//
// `ProjectionFields`, `WritableProjectionState`, and `SelectionState` are
// structural interfaces; the tests construct plain objects that satisfy them
// (a full WorkflowProjection + selection fields mirrors a real store state).
// ────────────────────────────────────────────────────────────────────────────

import { describe, expect, it } from 'bun:test';

// ── Unit under test ─────────────────────────────────────────────────────────
import {
  capAgentLogs,
  isTerminalTaskStatus,
  pickMostRecentlyStartedActive,
  reconcileSelection,
  toProjection,
  writeProjectionToState,
} from '@engin/shared/projection-helpers';

// ── Cross-check dependencies ────────────────────────────────────────────────
import type { AgentEntity, PhaseEntity, TaskEntity, WorkflowProjection } from '@engin/shared/event-types';
import { createInitialProjection } from '@engin/shared/event-types';
import { MAX_AGENT_LOG } from '@engin/shared/evolve';

// ── Constants ───────────────────────────────────────────────────────────────
const ISO_NOW = '2026-06-15T00:00:00.000Z';

// ── Fixture builders ────────────────────────────────────────────────────────

function logEntry(content: string) {
  return {
    id: `log-${content}`,
    timestamp: ISO_NOW,
    type: 'text' as const,
    content,
  };
}

/** Build an agent with sensible defaults; allow per-field overrides. */
function agent(overrides: Partial<AgentEntity> = {}): AgentEntity {
  return {
    uid: 'a1',
    agentId: 'a1',
    profile: 'coder',
    phaseId: '',
    active: true,
    log: [],
    toolCallCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    taskTitle: '',
    ...overrides,
  };
}

/** Build a task with sensible defaults; allow per-field overrides. */
function task(overrides: Partial<TaskEntity> = {}): TaskEntity {
  return {
    id: 't1',
    title: 'T1',
    status: 'ready',
    phaseId: 'exec',
    steps: [],
    dependencies: [],
    ...overrides,
  };
}

function phase(overrides: Partial<PhaseEntity> = {}): PhaseEntity {
  return { id: 'exec', label: 'Exec', icon: '⚡', taskIds: [], ...overrides };
}

/** Seed a WorkflowProjection from createInitialProjection with overrides. */
function blankProjection(overrides: Partial<WorkflowProjection> = {}): WorkflowProjection {
  return { ...createInitialProjection(), ...overrides };
}

/** A full store-like state: projection fields + selection fields. Mutable. */
function storeState(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...createInitialProjection(),
    selectedPhaseId: null as string | null,
    selectedTaskId: null as string | null,
    selectedStepIndex: null as number | null,
    userPinnedPhase: false,
    userPinnedStep: false,
    ...overrides,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// capAgentLogs
// ────────────────────────────────────────────────────────────────────────────

describe('projection-helpers – capAgentLogs', () => {
  it('returns a new record object (never the input reference)', () => {
    const agents: Record<string, AgentEntity> = { a1: agent() };
    const out = capAgentLogs(agents);
    expect(out).not.toBe(agents);
  });

  it('returns an empty object for an empty agents record', () => {
    const out = capAgentLogs({});
    expect(out).toEqual({});
  });

  it('preserves short-log agents by the SAME reference (no copy)', () => {
    const a = agent({ log: [logEntry('x')] });
    const out = capAgentLogs({ a1: a });
    expect(out['a1']).toBe(a); // identical reference
    expect(out['a1'].log).toBe(a.log);
  });

  it('preserves all non-log fields on capped agents', () => {
    const oversized = Array.from({ length: MAX_AGENT_LOG + 5 }, (_, i) => logEntry(`e-${i}`));
    const a = agent({
      uid: 'a1::t1',
      agentId: 'a1',
      profile: 'reviewer',
      phaseId: 'exec',
      taskId: 't1',
      active: false,
      log: oversized,
      toolCallCount: 7,
      inputTokens: 100,
      outputTokens: 50,
      taskTitle: 'Do thing',
    });

    const out = capAgentLogs({ a1: a });
    const capped = out['a1'];
    expect(capped).not.toBe(a); // a NEW object (log was sliced)
    expect(capped.uid).toBe('a1::t1');
    expect(capped.agentId).toBe('a1');
    expect(capped.profile).toBe('reviewer');
    expect(capped.phaseId).toBe('exec');
    expect(capped.taskId).toBe('t1');
    expect(capped.active).toBe(false);
    expect(capped.toolCallCount).toBe(7);
    expect(capped.inputTokens).toBe(100);
    expect(capped.outputTokens).toBe(50);
    expect(capped.taskTitle).toBe('Do thing');
  });

  it('caps an oversized log at exactly MAX_AGENT_LOG, dropping the oldest', () => {
    const oversized = Array.from({ length: MAX_AGENT_LOG + 10 }, (_, i) => logEntry(`e-${i}`));
    const a = agent({ log: oversized });

    const out = capAgentLogs({ a1: a });
    expect(out['a1'].log).toHaveLength(MAX_AGENT_LOG);
    // Keeps the LAST MAX_AGENT_LOG entries → first kept is e-10, last is e-(MAX+9).
    expect(out['a1'].log[0].content).toBe('e-10');
    expect(out['a1'].log[MAX_AGENT_LOG - 1].content).toBe(`e-${MAX_AGENT_LOG + 9}`);
  });

  it('does NOT cap a log whose length is exactly MAX_AGENT_LOG (strict >)', () => {
    const exact = Array.from({ length: MAX_AGENT_LOG }, (_, i) => logEntry(`e-${i}`));
    const a = agent({ log: exact });

    const out = capAgentLogs({ a1: a });
    // length === MAX_AGENT_LOG is NOT > MAX_AGENT_LOG → same reference, untouched.
    expect(out['a1']).toBe(a);
    expect(out['a1'].log).toBe(exact);
    expect(out['a1'].log).toHaveLength(MAX_AGENT_LOG);
  });

  it('caps a log of length MAX_AGENT_LOG + 1 down to MAX_AGENT_LOG', () => {
    const overByOne = Array.from({ length: MAX_AGENT_LOG + 1 }, (_, i) => logEntry(`e-${i}`));
    const a = agent({ log: overByOne });

    const out = capAgentLogs({ a1: a });
    expect(out['a1'].log).toHaveLength(MAX_AGENT_LOG);
    // Oldest (e-0) dropped; first kept is e-1.
    expect(out['a1'].log[0].content).toBe('e-1');
  });

  it('handles a mix of capped and uncapped agents independently', () => {
    const short = agent({ log: [logEntry('s1')] });
    const long = agent({ log: Array.from({ length: MAX_AGENT_LOG + 3 }, (_, i) => logEntry(`l-${i}`)) });

    const out = capAgentLogs({ short, long });
    expect(out['short']).toBe(short); // untouched, same ref
    expect(out['long']).not.toBe(long); // capped, new object
    expect(out['long'].log).toHaveLength(MAX_AGENT_LOG);
    expect(out['long'].log[0].content).toBe('l-3');
  });

  it('does not mutate the input agents record or its agent objects', () => {
    const oversized = Array.from({ length: MAX_AGENT_LOG + 2 }, (_, i) => logEntry(`e-${i}`));
    const a = agent({ log: oversized });
    const agents = { a1: a };

    capAgentLogs(agents);

    // Input agent object untouched.
    expect(agents['a1'].log).toBe(oversized);
    expect(agents['a1'].log).toHaveLength(MAX_AGENT_LOG + 2);
    // Input record still holds the original agent reference.
    expect(agents['a1']).toBe(a);
  });

  it('preserves insertion order of keys', () => {
    const agents: Record<string, AgentEntity> = {};
    for (const id of ['z', 'a', 'm', 'b']) agents[id] = agent();
    const out = capAgentLogs(agents);
    expect(Object.keys(out)).toEqual(['z', 'a', 'm', 'b']);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// toProjection
// ────────────────────────────────────────────────────────────────────────────

describe('projection-helpers – toProjection', () => {
  it('returns a WorkflowProjection with runLog reset to an empty array', () => {
    const fields = blankProjection({ seq: 5, taskPrompt: 'build' });
    const proj = toProjection(fields);
    expect(proj.runLog).toEqual([]);
    expect(Array.isArray(proj.runLog)).toBe(true);
  });

  it('returns runLog:[] even when the input carried a non-empty runLog', () => {
    const fields = blankProjection({
      runLog: [{ id: 'r1', timestamp: ISO_NOW, type: 'text', content: 'server line' }],
    });
    const proj = toProjection(fields);
    expect(proj.runLog).toEqual([]);
  });

  it('copies every projection field value from the input', () => {
    const fields = blankProjection({
      seq: 42,
      taskPrompt: 'ship it',
      phases: [phase({ id: 'plan', label: 'Plan', icon: '📋' })],
      currentPhaseId: 'exec',
      completedPhaseIds: ['plan'],
      tasks: {
        t1: task({ id: 't1', title: 'T1', status: 'active', phaseId: 'exec' }),
      },
      agents: {
        'a1::t1': agent({
          uid: 'a1::t1',
          taskId: 't1',
          profile: 'coder',
          toolCallCount: 3,
        }),
      },
      sidebar: { title: 'App', indicator: 'green' },
      status: 'running',
      error: undefined,
      failedPhase: undefined,
      stats: { totalTokens: 999, agentCount: 1 },
    });

    const proj = toProjection(fields);
    expect(proj.seq).toBe(42);
    expect(proj.taskPrompt).toBe('ship it');
    expect(proj.phases).toEqual([phase({ id: 'plan', label: 'Plan', icon: '📋' })]);
    expect(proj.currentPhaseId).toBe('exec');
    expect(proj.completedPhaseIds).toEqual(['plan']);
    expect(proj.tasks['t1'].title).toBe('T1');
    expect(proj.agents['a1::t1'].toolCallCount).toBe(3);
    expect(proj.sidebar).toEqual({ title: 'App', indicator: 'green' });
    expect(proj.status).toBe('running');
    expect(proj.stats).toEqual({ totalTokens: 999, agentCount: 1 });
  });

  it('propagates error / failedPhase when present', () => {
    const fields = blankProjection({
      status: 'failed',
      error: 'kaboom',
      failedPhase: 'exec',
    });
    const proj = toProjection(fields);
    expect(proj.status).toBe('failed');
    expect(proj.error).toBe('kaboom');
    expect(proj.failedPhase).toBe('exec');
  });

  it('does not mutate the input object', () => {
    const fields = blankProjection({ seq: 1, taskPrompt: 'x' });
    toProjection(fields);
    expect(fields.seq).toBe(1);
    expect(fields.taskPrompt).toBe('x');
    // runLog on the input is untouched (the reset lives on the RETURN value).
    expect((fields as WorkflowProjection).runLog).toEqual([]);
  });

  it('works when called with the canonical projection fields mapped from a *ById store', () => {
    // Simulates the web workflow-store mapping tasksById/agentsById → canonical
    // names before calling the shared toProjection (task-15 will do this).
    const webLike = {
      seq: 8,
      taskPrompt: 'web',
      phases: [] as PhaseEntity[],
      currentPhaseId: 'exec',
      completedPhaseIds: [] as string[],
      tasks: { t1: task() } as Record<string, TaskEntity>,
      agents: { a1: agent() } as Record<string, AgentEntity>,
      sidebar: { title: '', indicator: '' },
      status: 'running' as const,
      error: undefined,
      failedPhase: undefined,
      stats: { totalTokens: 0, agentCount: 0 },
    };

    const proj = toProjection(webLike);
    expect(proj.seq).toBe(8);
    expect(proj.taskPrompt).toBe('web');
    expect(proj.tasks['t1']).toBeDefined();
    expect(proj.agents['a1']).toBeDefined();
    expect(proj.runLog).toEqual([]);
  });

  it('produces a projection whose runLog is distinct from the input runLog array', () => {
    const inputRunLog = [logEntry('x')];
    const fields = blankProjection({ runLog: inputRunLog });
    const proj = toProjection(fields);
    expect(proj.runLog).not.toBe(inputRunLog);
    expect(proj.runLog).toEqual([]);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// writeProjectionToState
// ────────────────────────────────────────────────────────────────────────────

describe('projection-helpers – writeProjectionToState', () => {
  it('writes every normalized projection field into the state', () => {
    const state = storeState();
    const p = blankProjection({
      taskPrompt: 'build',
      phases: [phase({ id: 'plan' })],
      currentPhaseId: 'exec',
      completedPhaseIds: ['plan'],
      tasks: { t1: task({ id: 't1', status: 'active' }) },
      agents: { a1: agent({ profile: 'coder' }) },
      sidebar: { title: 'App', indicator: 'green' },
      status: 'running',
      stats: { totalTokens: 10, agentCount: 1 },
    });

    writeProjectionToState(state, p);

    expect(state['taskPrompt']).toBe('build');
    expect((state['phases'] as PhaseEntity[])[0].id).toBe('plan');
    expect(state['currentPhaseId']).toBe('exec');
    expect(state['completedPhaseIds']).toEqual(['plan']);
    expect((state['tasks'] as Record<string, TaskEntity>)['t1'].status).toBe('active');
    expect((state['agents'] as Record<string, AgentEntity>)['a1'].profile).toBe('coder');
    expect(state['sidebar']).toEqual({ title: 'App', indicator: 'green' });
    expect(state['status']).toBe('running');
    expect(state['stats']).toEqual({ totalTokens: 10, agentCount: 1 });
  });

  it('writes error / failedPhase when present on the projection', () => {
    const state = storeState();
    const p = blankProjection({ status: 'failed', error: 'oops', failedPhase: 'exec' });

    writeProjectionToState(state, p);

    expect(state['error']).toBe('oops');
    expect(state['failedPhase']).toBe('exec');
    expect(state['status']).toBe('failed');
  });

  it('does NOT write seq (seq is managed separately by the store)', () => {
    const state = storeState({ seq: 0 });
    const p = blankProjection({ seq: 99 });

    writeProjectionToState(state, p);

    expect(state['seq']).toBe(0); // untouched
  });

  it('does NOT write runLog (runLog is managed via appendRunLog)', () => {
    const sentinel = [{ id: 'keep', timestamp: ISO_NOW, type: 'text', content: 'keep' }];
    const state = storeState({ runLog: sentinel });
    const p = blankProjection({
      runLog: [{ id: 'x', timestamp: ISO_NOW, type: 'text', content: 'x' }],
    });

    writeProjectionToState(state, p);

    expect(state['runLog']).toBe(sentinel); // same reference, untouched
  });

  it('makes defensive shallow copies of container collections (tasks)', () => {
    const state = storeState();
    const p = blankProjection({
      tasks: { t1: task({ id: 't1' }) },
    });

    writeProjectionToState(state, p);

    const stateTasks = state['tasks'] as Record<string, TaskEntity>;
    expect(stateTasks).not.toBe(p.tasks); // new object
    // But task entries are shared (shallow).
    expect(stateTasks['t1']).toBe(p.tasks['t1']);
    // Mutating the source record after writing does not bleed into state.
    p.tasks['t2'] = task({ id: 't2' });
    expect(Object.keys(stateTasks)).toEqual(['t1']);
  });

  it('makes defensive copies of phases (array)', () => {
    const state = storeState();
    const p = blankProjection({ phases: [phase({ id: 'p1' })] });

    writeProjectionToState(state, p);

    const statePhases = state['phases'] as PhaseEntity[];
    expect(statePhases).not.toBe(p.phases);
    p.phases.push(phase({ id: 'p2' }));
    expect(statePhases).toHaveLength(1);
    expect(statePhases[0].id).toBe('p1');
  });

  it('makes defensive copies of completedPhaseIds (array)', () => {
    const state = storeState();
    const p = blankProjection({ completedPhaseIds: ['plan'] });

    writeProjectionToState(state, p);

    const stateCompleted = state['completedPhaseIds'] as string[];
    expect(stateCompleted).not.toBe(p.completedPhaseIds);
    p.completedPhaseIds.push('exec');
    expect(stateCompleted).toEqual(['plan']);
  });

  it('makes defensive copies of sidebar and stats (objects)', () => {
    const state = storeState();
    const p = blankProjection({
      sidebar: { title: 'A', indicator: 'g' },
      stats: { totalTokens: 5, agentCount: 1 },
    });

    writeProjectionToState(state, p);

    expect(state['sidebar']).not.toBe(p.sidebar);
    expect(state['stats']).not.toBe(p.stats);
    expect(state['sidebar']).toEqual({ title: 'A', indicator: 'g' });
    expect(state['stats']).toEqual({ totalTokens: 5, agentCount: 1 });
  });

  // ── fromSnapshot gating (the unified boolean parameter) ─────────────────

  describe('fromSnapshot (default false)', () => {
    it('passes agents through UNCAPPED and by reference when fromSnapshot is omitted', () => {
      const state = storeState();
      const oversized = Array.from({ length: MAX_AGENT_LOG + 5 }, (_, i) => logEntry(`e-${i}`));
      const p = blankProjection({
        agents: { a1: agent({ log: oversized }) },
      });

      writeProjectionToState(state, p); // fromSnapshot defaults to false

      const stateAgents = state['agents'] as Record<string, AgentEntity>;
      // Same reference (no cap, no copy) — the event-folding path relies on
      // evolve having already enforced the cap.
      expect(stateAgents).toBe(p.agents);
      expect(stateAgents['a1'].log).toHaveLength(MAX_AGENT_LOG + 5); // NOT capped
    });

    it('passes agents through UNCAPPED when fromSnapshot is explicitly false', () => {
      const state = storeState();
      const oversized = Array.from({ length: MAX_AGENT_LOG + 5 }, (_, i) => logEntry(`e-${i}`));
      const p = blankProjection({ agents: { a1: agent({ log: oversized }) } });

      writeProjectionToState(state, p, false);

      const stateAgents = state['agents'] as Record<string, AgentEntity>;
      expect(stateAgents).toBe(p.agents);
      expect(stateAgents['a1'].log).toHaveLength(MAX_AGENT_LOG + 5);
    });
  });

  describe('fromSnapshot = true (snapshot path)', () => {
    it('caps oversized agent logs defensively (untrusted external source)', () => {
      const state = storeState();
      const oversized = Array.from({ length: MAX_AGENT_LOG + 10 }, (_, i) => logEntry(`e-${i}`));
      const p = blankProjection({ agents: { a1: agent({ log: oversized }) } });

      writeProjectionToState(state, p, true);

      const stateAgents = state['agents'] as Record<string, AgentEntity>;
      expect(stateAgents['a1'].log).toHaveLength(MAX_AGENT_LOG);
      expect(stateAgents['a1'].log[0].content).toBe('e-10');
    });

    it('replaces the agents record with a NEW object (capAgentLogs output)', () => {
      const state = storeState();
      const p = blankProjection({ agents: { a1: agent() } });

      writeProjectionToState(state, p, true);

      expect(state['agents']).not.toBe(p.agents); // new record
    });

    it('leaves short agent logs intact when fromSnapshot is true', () => {
      const state = storeState();
      const p = blankProjection({
        agents: { a1: agent({ log: [logEntry('only')] }) },
      });

      writeProjectionToState(state, p, true);

      const stateAgents = state['agents'] as Record<string, AgentEntity>;
      expect(stateAgents['a1'].log).toHaveLength(1);
      expect(stateAgents['a1'].log[0].content).toBe('only');
    });
  });
});

// ────────────────────────────────────────────────────────────────────────────
// isTerminalTaskStatus + pickMostRecentlyStartedActive
//
// These two small pure helpers are the shared core of the task-completion-
// reselection rule (req 2). They are used by BOTH the store-facing
// `reconcileSelection` (via prevSelectedTaskStatus) and the TUI
// `Dashboard._applySelectionToWidgets` (via oldProjection), so a dedicated
// unit test pins them in isolation and guards against the two call sites
// diverging (the DRY motivation for extracting them).
// ────────────────────────────────────────────────────────────────────────────

describe('projection-helpers – isTerminalTaskStatus', () => {
  it('returns true for complete / failed / cancelled', () => {
    expect(isTerminalTaskStatus('complete')).toBe(true);
    expect(isTerminalTaskStatus('failed')).toBe(true);
    expect(isTerminalTaskStatus('cancelled')).toBe(true);
  });

  it('returns false for the non-terminal statuses', () => {
    expect(isTerminalTaskStatus('ready')).toBe(false);
    expect(isTerminalTaskStatus('blocked')).toBe(false);
    expect(isTerminalTaskStatus('active')).toBe(false);
  });
});

describe('projection-helpers – pickMostRecentlyStartedActive', () => {
  it('returns undefined for an empty list', () => {
    expect(pickMostRecentlyStartedActive([])).toBeUndefined();
  });

  it('returns undefined when no task is active', () => {
    const tasks = [
      task({ id: 't1', status: 'ready' }),
      task({ id: 't2', status: 'complete' }),
      task({ id: 't3', status: 'failed' }),
    ];
    expect(pickMostRecentlyStartedActive(tasks)).toBeUndefined();
  });

  it('picks the active task with the greatest startedAt', () => {
    const tB = task({ id: 'tB', status: 'active', startedAt: 5000 });
    const tasks = [
      task({ id: 'tA', status: 'active', startedAt: 1000 }),
      tB,
      task({ id: 'tC', status: 'active', startedAt: 3000 }),
    ];
    expect(pickMostRecentlyStartedActive(tasks)).toBe(tB);
  });

  it('ignores non-active tasks even when they have a greater startedAt', () => {
    const tActive = task({ id: 'tActive', status: 'active', startedAt: 100 });
    const tasks = [tActive, task({ id: 'tDone', status: 'complete', startedAt: 9999 })];
    expect(pickMostRecentlyStartedActive(tasks)).toBe(tActive);
  });

  it('treats a missing startedAt as the oldest (−Infinity)', () => {
    // tExplicit has a timestamp; tMissing has none → tMissing loses.
    const tExplicit = task({ id: 'tExplicit', status: 'active', startedAt: 99 });
    const tasks = [
      tExplicit,
      task({ id: 'tMissing', status: 'active' }), // no startedAt
    ];
    expect(pickMostRecentlyStartedActive(tasks)).toBe(tExplicit);
  });

  it('returns the single active task when only one is active', () => {
    const only = task({ id: 'only', status: 'active', startedAt: 7 });
    const tasks = [task({ id: 'other', status: 'ready', startedAt: 999 }), only];
    expect(pickMostRecentlyStartedActive(tasks)).toBe(only);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// reconcileSelection
// ────────────────────────────────────────────────────────────────────────────

describe('projection-helpers – reconcileSelection', () => {
  // ── Phase follow ──────────────────────────────────────────────────────────

  describe('phase follow', () => {
    it('auto-selects currentPhaseId when selectedPhaseId is null', () => {
      const state = storeState({ currentPhaseId: 'exec' }) as Record<string, unknown>;
      state['selectedPhaseId'] = null;

      reconcileSelection(state as never);

      expect(state['selectedPhaseId']).toBe('exec');
    });

    it('does nothing when selectedPhaseId is null and currentPhaseId is empty', () => {
      const state = storeState({ currentPhaseId: '' });
      state['selectedPhaseId'] = null;

      reconcileSelection(state as never);

      expect(state['selectedPhaseId']).toBeNull();
    });

    // NOTE: the Dashboard's TIGHTENED phase-follow (req 6) — mirrored here by
    // the shared helper — only advances the selected phase when the user WAS
    // synced with the active phase (selectedPhaseId === prevCurrentPhaseId)
    // AND the active phase advanced. A selected phase that is neither the
    // current phase nor carried forward from it is an intentional detour and
    // is left alone. Completion no longer exempts a phase on its own.

    it('follows currentPhaseId when synced to the previous current phase and it advanced (req 6)', () => {
      // The user was synced with the active phase and the active phase
      // advanced → pull them along, resetting task/step selection for the new
      // phase so it starts clean.
      const state = storeState({
        currentPhaseId: 'exec',
        completedPhaseIds: [],
        tasks: { 't-old': task({ id: 't-old', status: 'active', phaseId: 'scouting' }) },
      });
      state['prevCurrentPhaseId'] = 'scouting'; // was synced to scouting
      state['selectedPhaseId'] = 'scouting';
      state['userPinnedPhase'] = false;
      state['selectedTaskId'] = 't-old';
      state['selectedStepIndex'] = 3;
      state['userPinnedStep'] = true;

      reconcileSelection(state as never);

      expect(state['selectedPhaseId']).toBe('exec');
      expect(state['userPinnedPhase']).toBe(false);
      // Follow resets task/step selection for the new phase.
      expect(state['selectedTaskId']).toBeNull();
      expect(state['selectedStepIndex']).toBeNull();
      expect(state['userPinnedStep']).toBe(false);
    });

    it('does NOT follow when the user navigated to a phase that was not the current phase (req 6)', () => {
      // An intentional detour: selectedPhaseId is neither the (previous)
      // current phase nor carried forward from it → leave it alone. (The old
      // broad rule would have snapped a non-completed phase back to
      // currentPhaseId; that no longer happens.)
      const state = storeState({
        currentPhaseId: 'exec',
        completedPhaseIds: [],
      });
      state['prevCurrentPhaseId'] = 'scouting';
      state['selectedPhaseId'] = 'review'; // detour — was never the current phase

      reconcileSelection(state as never);

      expect(state['selectedPhaseId']).toBe('review'); // stays — intentional detour
    });

    it('keeps a user-selected completed phase selected (not synced to the current phase)', () => {
      // A completed phase the user pinned to review is not the current phase,
      // so selectedPhaseId !== prevCurrentPhaseId → no follow → stays.
      const state = storeState({
        currentPhaseId: 'exec',
        completedPhaseIds: ['plan'],
      });
      state['prevCurrentPhaseId'] = 'exec';
      state['selectedPhaseId'] = 'plan'; // pinned completed phase

      reconcileSelection(state as never);

      expect(state['selectedPhaseId']).toBe('plan');
    });

    it('keeps selection when selectedPhaseId already equals currentPhaseId (no advance)', () => {
      const state = storeState({
        currentPhaseId: 'exec',
        completedPhaseIds: [],
      });
      state['prevCurrentPhaseId'] = 'exec';
      state['selectedPhaseId'] = 'exec';

      reconcileSelection(state as never);

      expect(state['selectedPhaseId']).toBe('exec');
    });
  });

  // ── Task follow ───────────────────────────────────────────────────────────

  describe('task follow', () => {
    it('auto-selects the first ACTIVE task when selectedTaskId is null', () => {
      const state = storeState({
        currentPhaseId: 'exec',
        phases: [phase({ id: 'exec', taskIds: ['t1', 't2'] })],
        tasks: {
          t1: task({ id: 't1', status: 'ready', phaseId: 'exec' }),
          t2: task({ id: 't2', status: 'active', phaseId: 'exec' }),
        },
      });
      state['selectedPhaseId'] = 'exec';
      state['selectedTaskId'] = null;

      reconcileSelection(state as never);

      expect(state['selectedTaskId']).toBe('t2'); // first active
    });

    it('falls back to the first task when no active task exists', () => {
      const state = storeState({
        currentPhaseId: 'exec',
        tasks: {
          t1: task({ id: 't1', status: 'ready', phaseId: 'exec' }),
          t2: task({ id: 't2', status: 'complete', phaseId: 'exec' }),
        },
      });
      state['selectedPhaseId'] = 'exec';
      state['selectedTaskId'] = null;

      reconcileSelection(state as never);

      expect(state['selectedTaskId']).toBe('t1'); // first task overall
    });

    it('sets selectedTaskId to null when the selected phase has no tasks', () => {
      const state = storeState({
        currentPhaseId: 'exec',
        tasks: {},
      });
      state['selectedPhaseId'] = 'exec';
      state['selectedTaskId'] = null;

      reconcileSelection(state as never);

      expect(state['selectedTaskId']).toBeNull();
    });

    it('re-selects first active when selectedTaskId no longer belongs to the selected phase', () => {
      const state = storeState({
        currentPhaseId: 'exec',
        tasks: {
          t1: task({ id: 't1', status: 'ready', phaseId: 'exec' }),
          t2: task({ id: 't2', status: 'active', phaseId: 'exec' }),
          t3: task({ id: 't3', status: 'active', phaseId: 'review' }),
        },
      });
      state['selectedPhaseId'] = 'exec';
      state['selectedTaskId'] = 't3'; // belongs to a different phase

      reconcileSelection(state as never);

      expect(state['selectedTaskId']).toBe('t2'); // first active in exec
    });

    it('keeps a valid selectedTaskId that belongs to the selected phase', () => {
      const state = storeState({
        currentPhaseId: 'exec',
        tasks: {
          t1: task({ id: 't1', status: 'active', phaseId: 'exec' }),
        },
      });
      state['selectedPhaseId'] = 'exec';
      state['selectedTaskId'] = 't1';

      reconcileSelection(state as never);

      expect(state['selectedTaskId']).toBe('t1');
    });

    it('resets selectedStepIndex and userPinnedStep when the task is re-selected', () => {
      const state = storeState({
        currentPhaseId: 'exec',
        tasks: {
          t1: task({ id: 't1', status: 'active', phaseId: 'exec', activeStepIndex: 2 }),
        },
      });
      state['selectedPhaseId'] = 'exec';
      state['selectedTaskId'] = null; // triggers re-selection
      state['selectedStepIndex'] = 9;
      state['userPinnedStep'] = true;

      reconcileSelection(state as never);

      // Task re-selected (t1) → step reset, then step-follow re-syncs to 2.
      expect(state['selectedTaskId']).toBe('t1');
      expect(state['userPinnedStep']).toBe(false);
      expect(state['selectedStepIndex']).toBe(2);
    });

    it('skips task follow when selectedPhaseId is null', () => {
      const state = storeState({
        currentPhaseId: '',
        tasks: {
          t1: task({ id: 't1', status: 'active', phaseId: 'exec' }),
        },
      });
      state['selectedPhaseId'] = null;
      state['selectedTaskId'] = null;

      reconcileSelection(state as never);

      expect(state['selectedTaskId']).toBeNull();
    });
  });

  // ── Task completion reselection (req 2) ──────────────────────────────────
  //
  // When the SELECTED task transitioned OUT of 'active' (→ complete / failed /
  // cancelled) and other active tasks remain in the phase, re-select the
  // most-recently-started (greatest startedAt, i.e. least active time) active
  // task. If no active task remains, keep the completed task selected
  // (intended). Mirrors the Dashboard's req-2 rule (task-4).

  describe('task completion reselection (req 2)', () => {
    it('re-selects the most-recently-started active task when the selected active task completes', () => {
      const state = storeState({
        currentPhaseId: 'exec',
        tasks: {
          t1: task({ id: 't1', status: 'complete', phaseId: 'exec', startedAt: 50 }),
          t2: task({ id: 't2', status: 'active', phaseId: 'exec', startedAt: 100 }),
          t3: task({ id: 't3', status: 'active', phaseId: 'exec', startedAt: 200 }),
        },
      });
      state['selectedPhaseId'] = 'exec';
      state['selectedTaskId'] = 't1';
      state['prevSelectedTaskStatus'] = 'active'; // t1 WAS active last call
      state['selectedStepIndex'] = 4;
      state['userPinnedStep'] = true;

      reconcileSelection(state as never);

      // t3 has the greatest startedAt (most recently started).
      expect(state['selectedTaskId']).toBe('t3');
      expect(state['selectedStepIndex']).toBeNull(); // reset
      expect(state['userPinnedStep']).toBe(false); // reset
    });

    it('re-selects an active task on failed / cancelled transitions too', () => {
      for (const terminal of ['failed', 'cancelled'] as const) {
        const state = storeState({
          currentPhaseId: 'exec',
          tasks: {
            t1: task({ id: 't1', status: terminal, phaseId: 'exec', startedAt: 10 }),
            t2: task({ id: 't2', status: 'active', phaseId: 'exec', startedAt: 20 }),
          },
        });
        state['selectedPhaseId'] = 'exec';
        state['selectedTaskId'] = 't1';
        state['prevSelectedTaskStatus'] = 'active';

        reconcileSelection(state as never);

        expect(state['selectedTaskId']).toBe('t2');
      }
    });

    it('keeps the completed task selected when no active task remains', () => {
      const state = storeState({
        currentPhaseId: 'exec',
        tasks: {
          t1: task({ id: 't1', status: 'complete', phaseId: 'exec', startedAt: 10 }),
          t2: task({ id: 't2', status: 'ready', phaseId: 'exec', startedAt: 20 }),
        },
      });
      state['selectedPhaseId'] = 'exec';
      state['selectedTaskId'] = 't1';
      state['prevSelectedTaskStatus'] = 'active';

      reconcileSelection(state as never);

      // No active task remains → keep the completed task selected (intended).
      expect(state['selectedTaskId']).toBe('t1');
    });

    it('does NOT re-select when the selected task was not previously active', () => {
      // prevSelectedTaskStatus !== 'active' → no completion-reselection. E.g. a
      // 'ready' task that flips to 'complete' (skipped) is left selected only
      // if it is still the first-active fallback; here another active task is
      // present but the selected task stays because no transition is detected.
      const state = storeState({
        currentPhaseId: 'exec',
        tasks: {
          t1: task({ id: 't1', status: 'complete', phaseId: 'exec', startedAt: 10 }),
          t2: task({ id: 't2', status: 'active', phaseId: 'exec', startedAt: 20 }),
        },
      });
      state['selectedPhaseId'] = 'exec';
      state['selectedTaskId'] = 't1';
      state['prevSelectedTaskStatus'] = 'ready'; // NOT active → no reselection

      reconcileSelection(state as never);

      expect(state['selectedTaskId']).toBe('t1'); // untouched
    });

    it('treats a missing startedAt as the oldest (least-recently-started) active task', () => {
      // t2 has an explicit startedAt; t3 has none (→ -Infinity). The rule must
      // pick t2 (the one with a timestamp), not the undefined-startedAt task.
      const state = storeState({
        currentPhaseId: 'exec',
        tasks: {
          t1: task({ id: 't1', status: 'complete', phaseId: 'exec', startedAt: 5 }),
          t2: task({ id: 't2', status: 'active', phaseId: 'exec', startedAt: 99 }),
          t3: task({ id: 't3', status: 'active', phaseId: 'exec' }), // no startedAt
        },
      });
      state['selectedPhaseId'] = 'exec';
      state['selectedTaskId'] = 't1';
      state['prevSelectedTaskStatus'] = 'active';

      reconcileSelection(state as never);

      expect(state['selectedTaskId']).toBe('t2'); // greatest startedAt
    });
  });

  // ── Step follow ───────────────────────────────────────────────────────────

  describe('step follow', () => {
    it('syncs selectedStepIndex to the task activeStepIndex when not pinned', () => {
      const state = storeState({
        currentPhaseId: 'exec',
        tasks: {
          t1: task({
            id: 't1',
            status: 'active',
            phaseId: 'exec',
            activeStepIndex: 1,
            steps: [
              { name: 's0', index: 0 },
              { name: 's1', index: 1 },
            ],
          }),
        },
      });
      state['selectedPhaseId'] = 'exec';
      state['selectedTaskId'] = 't1';
      state['userPinnedStep'] = false;

      reconcileSelection(state as never);

      expect(state['selectedStepIndex']).toBe(1);
    });

    it('does NOT sync selectedStepIndex when userPinnedStep is true', () => {
      const state = storeState({
        currentPhaseId: 'exec',
        tasks: {
          t1: task({ id: 't1', status: 'active', phaseId: 'exec', activeStepIndex: 2 }),
        },
      });
      state['selectedPhaseId'] = 'exec';
      state['selectedTaskId'] = 't1';
      state['selectedStepIndex'] = 0;
      state['userPinnedStep'] = true;

      reconcileSelection(state as never);

      expect(state['selectedStepIndex']).toBe(0); // pinned, not overridden
    });

    it('leaves selectedStepIndex unchanged when the task has no activeStepIndex', () => {
      const state = storeState({
        currentPhaseId: 'exec',
        tasks: {
          t1: task({ id: 't1', status: 'active', phaseId: 'exec' }), // no activeStepIndex
        },
      });
      state['selectedPhaseId'] = 'exec';
      state['selectedTaskId'] = 't1';
      state['selectedStepIndex'] = 4;
      state['userPinnedStep'] = false;

      reconcileSelection(state as never);

      expect(state['selectedStepIndex']).toBe(4); // unchanged
    });

    it('skips step follow when selectedTaskId is null', () => {
      const state = storeState({
        currentPhaseId: 'exec',
        tasks: {},
      });
      state['selectedPhaseId'] = 'exec';
      state['selectedTaskId'] = null;
      state['selectedStepIndex'] = 3;
      state['userPinnedStep'] = false;

      reconcileSelection(state as never);

      expect(state['selectedStepIndex']).toBe(3); // untouched
    });
  });

  // ── Holistic reconcile (phase → task → step in one pass) ─────────────────

  it('reconciles phase → task → step holistically on a fresh connect', () => {
    const state = storeState({
      currentPhaseId: 'exec',
      phases: [phase({ id: 'exec', taskIds: ['t1'] })],
      tasks: {
        t1: task({
          id: 't1',
          status: 'active',
          phaseId: 'exec',
          activeStepIndex: 0,
          steps: [{ name: 's0', index: 0 }],
        }),
      },
    });
    // Fresh state: nothing selected.
    state['selectedPhaseId'] = null;
    state['selectedTaskId'] = null;
    state['selectedStepIndex'] = null;

    reconcileSelection(state as never);

    expect(state['selectedPhaseId']).toBe('exec');
    expect(state['selectedTaskId']).toBe('t1');
    expect(state['selectedStepIndex']).toBe(0);
  });

  it('does not throw on an entirely empty/initial state', () => {
    const state = storeState();
    expect(() => reconcileSelection(state as never)).not.toThrow();
    expect(state['selectedPhaseId']).toBeNull();
    expect(state['selectedTaskId']).toBeNull();
    expect(state['selectedStepIndex']).toBeNull();
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Parity with ClientStore (behavior-preserving extraction)
// ────────────────────────────────────────────────────────────────────────────

describe('projection-helpers – ClientStore parity', () => {
  // These tests verify that the shared helpers reproduce the EXACT selection
  // behavior the ClientStore exhibited before the extraction. They build a
  // store-like state, run reconcileSelection directly, and assert the same
  // outcomes that tests/shared/client-store.test.ts asserts via the public API.

  it('phase follow: keeps a pinned completed phase across a currentPhaseId move', () => {
    // The user pinned a completed phase (plan) to review history. Because plan
    // is not the (previous) current phase, selectedPhaseId !== prevCurrentPhaseId,
    // so the tightened follow rule leaves it selected.
    const state = storeState({
      currentPhaseId: 'review',
      completedPhaseIds: ['plan', 'exec'],
      phases: [phase({ id: 'plan' }), phase({ id: 'exec' }), phase({ id: 'review', taskIds: ['t2'] })],
      tasks: {
        t2: task({ id: 't2', status: 'ready', phaseId: 'review' }),
      },
    });
    state['prevCurrentPhaseId'] = 'review';
    state['selectedPhaseId'] = 'plan';
    state['userPinnedPhase'] = true; // pinned on a completed phase

    reconcileSelection(state as never);

    expect(state['selectedPhaseId']).toBe('plan'); // stays pinned
  });

  it('task follow: re-selects first active after selectedTaskId becomes stale', () => {
    const state = storeState({
      currentPhaseId: 'exec',
      tasks: {
        t1: task({ id: 't1', status: 'ready', phaseId: 'exec' }),
        t2: task({ id: 't2', status: 'active', phaseId: 'exec' }),
      },
    });
    state['selectedPhaseId'] = 'exec';
    state['selectedTaskId'] = 't-ghost'; // stale / not in phase

    reconcileSelection(state as never);

    expect(state['selectedTaskId']).toBe('t2');
  });
});

// ────────────────────────────────────────────────────────────────────────────
// reconcileSelection — prev-tracking write-back (transition detection for the
// tightened phase-follow + task-completion-reselection rules)
// ────────────────────────────────────────────────────────────────────────────
//
// `reconcileSelection` records the CURRENT (post-follow) values of the TWO
// quantities the transition-aware rules need to detect a change on the NEXT
// call:
//
//   • prevCurrentPhaseId      ← state.currentPhaseId || null
//                            (drives phase-follow: synced+advanced → follow)
//   • prevSelectedTaskStatus  ← post-follow selectedTask?.status ?? null
//                            (drives task-completion-reselection:
//                             active → complete|failed|cancelled → reselect)
//
// NOTE: there is intentionally NO prevActiveStepIndex. The shared step-follow
// stays the broad `userPinnedStep`-gated rule (the TUI-only expanded-state
// exception is not mirrored here), so it has no previous-state dependency.
//
// `selectedTask` is the POST-follow selected task (state.tasks[state.selectedTaskId],
// possibly undefined). These tests run against the loose `storeState()` Record
// (bracket access), so they compile regardless of whether the optional fields
// are declared yet, and FAIL until the write-back lands.
describe('projection-helpers – reconcileSelection prev-tracking write-back', () => {
  it('populates both prev fields from the current (post-follow) values', () => {
    const state = storeState({
      currentPhaseId: 'exec',
      tasks: {
        t1: task({ id: 't1', status: 'active', phaseId: 'exec', activeStepIndex: 2 }),
      },
    });
    state['selectedPhaseId'] = 'exec';
    state['selectedTaskId'] = 't1';
    state['selectedStepIndex'] = 2;

    reconcileSelection(state as never);

    expect(state['prevCurrentPhaseId']).toBe('exec');
    expect(state['prevSelectedTaskStatus']).toBe('active');
  });

  it('sets prevCurrentPhaseId to the state currentPhaseId (the source of truth)', () => {
    const state = storeState({ currentPhaseId: 'review', tasks: {} });
    state['selectedPhaseId'] = 'review';
    state['selectedTaskId'] = null;

    reconcileSelection(state as never);

    expect(state['prevCurrentPhaseId']).toBe('review');
    expect(state['prevCurrentPhaseId']).toBe(state['currentPhaseId']);
  });

  it('reflects prevSelectedTaskStatus as null when no task is selected', () => {
    const state = storeState({ currentPhaseId: 'exec', tasks: {} });
    state['selectedPhaseId'] = 'exec';
    state['selectedTaskId'] = null;

    reconcileSelection(state as never);

    expect(state['prevSelectedTaskStatus']).toBeNull();
    // prevCurrentPhaseId is still populated.
    expect(state['prevCurrentPhaseId']).toBe('exec');
  });

  it('writes back the POST-follow selected task (after task auto-selection)', () => {
    // selectedTaskId starts null; task-follow auto-selects the first active
    // task. The write-back must reflect the NEWLY selected task — not the stale
    // null the caller passed in. This is the transition the reselection rule
    // needs to detect on the next call.
    const state = storeState({
      currentPhaseId: 'exec',
      tasks: {
        t1: task({ id: 't1', status: 'ready', phaseId: 'exec' }),
        t2: task({ id: 't2', status: 'active', phaseId: 'exec', activeStepIndex: 1 }),
      },
    });
    state['selectedPhaseId'] = 'exec';
    state['selectedTaskId'] = null; // triggers auto-selection

    reconcileSelection(state as never);

    expect(state['selectedTaskId']).toBe('t2'); // auto-selected (first active)
    expect(state['prevSelectedTaskStatus']).toBe('active'); // reflects t2, not null
  });

  it('reflects a non-active selected-task status verbatim', () => {
    const state = storeState({
      currentPhaseId: 'exec',
      tasks: {
        t1: task({ id: 't1', status: 'ready', phaseId: 'exec', activeStepIndex: 3 }),
      },
    });
    state['selectedPhaseId'] = 'exec';
    state['selectedTaskId'] = 't1';

    reconcileSelection(state as never);

    expect(state['prevSelectedTaskStatus']).toBe('ready');
  });

  it('coerces an empty currentPhaseId to null on write-back', () => {
    // `prevCurrentPhaseId = state.currentPhaseId || null` → '' becomes null,
    // so a fresh store never holds a '' previous phase.
    const state = storeState(); // currentPhaseId ''

    reconcileSelection(state as never);

    expect(state['prevCurrentPhaseId']).toBeNull();
    expect(state['prevSelectedTaskStatus']).toBeNull();
  });

  it('updates prevCurrentPhaseId across successive reconcile calls (transition detection)', () => {
    // End-to-end demonstration: the write-back is what lets the NEXT call
    // detect a phase advancement and trigger phase-follow.
    const state = storeState({ currentPhaseId: 'scouting', tasks: {} });
    state['selectedPhaseId'] = null; // fresh connect → auto-selects scouting
    state['selectedTaskId'] = null;

    reconcileSelection(state as never);
    expect(state['selectedPhaseId']).toBe('scouting'); // auto-selected
    expect(state['prevCurrentPhaseId']).toBe('scouting');

    // currentPhaseId advances to exec; the user was synced to scouting
    // (selectedPhaseId === prevCurrentPhaseId) → tightened phase-follow follows.
    state['currentPhaseId'] = 'exec';
    reconcileSelection(state as never);

    expect(state['selectedPhaseId']).toBe('exec'); // followed the advance
    expect(state['prevCurrentPhaseId']).toBe('exec'); // updated → detectable
  });

  it('does NOT disturb the existing phase/task/step selection fields (purely additive)', () => {
    const state = storeState({
      currentPhaseId: 'exec',
      tasks: {
        t1: task({ id: 't1', status: 'active', phaseId: 'exec', activeStepIndex: 0 }),
      },
    });
    state['selectedPhaseId'] = 'exec';
    state['selectedTaskId'] = 't1';
    state['selectedStepIndex'] = 0;
    state['userPinnedPhase'] = false;
    state['userPinnedStep'] = false;

    reconcileSelection(state as never);

    // The five core selection fields are the SAME as they were before the
    // write-back (the write-back only touches the two prev fields).
    expect(state['selectedPhaseId']).toBe('exec');
    expect(state['selectedTaskId']).toBe('t1');
    expect(state['selectedStepIndex']).toBe(0);
    expect(state['userPinnedPhase']).toBe(false);
    expect(state['userPinnedStep']).toBe(false);
    // And the prev fields are populated alongside.
    expect(state['prevCurrentPhaseId']).toBe('exec');
    expect(state['prevSelectedTaskStatus']).toBe('active');
  });
});
