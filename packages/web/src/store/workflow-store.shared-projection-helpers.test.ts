/**
 * Refactor verification: workflow-store delegates its four projection helpers
 * to `@engin/shared/projection-helpers` (extracted in task-7), eliminating the
 * local duplicates that previously lived inside this module:
 *
 *   • capAgentLogs(agents)
 *   • toProjection(state)
 *   • writeProjectionToState(state, p)
 *   • reconcileSelection(state)
 *
 * The web store carries the SAME projection data under the suffixed field
 * names `agentsById` / `tasksById` (Immer-typed `Draft<WorkflowStoreState>`),
 * whereas the shared helpers operate on the CANONICAL projection names
 * (`agents` / `tasks`). The store therefore maps its fields onto the canonical
 * names around each shared-helper call. These tests pin BOTH halves of that
 * contract:
 *
 * Part A — Source inspection (migration pin): the store imports the helpers
 *   from the shared module and no longer defines local copies. These are
 *   intentionally RED until the refactor lands and GREEN thereafter — a clear
 *   go/no-go signal mirroring migration.shared-imports.test.ts.
 *
 * Part B — Delegation parity: each test drives the store's PUBLIC API and then
 *   asserts the store's OBSERVABLE state is byte-identical to what the SHARED
 *   helpers produce when invoked directly on an equivalent state. This
 *   dynamically pins the delegation: a wrong helper, a botched *ById↔canonical
 *   mapping, or a forgotten `fromSnapshot` flag surfaces here. The scenarios
 *   are chosen so the legacy local helpers and the shared helpers AGREE (so
 *   the guards are GREEN both before and after the refactor), complementing —
 *   not duplicating — the hardcoded assertions in workflow-store.test.ts.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';

// ── Shared modules under test (invoked directly for parity comparison) ──────
import { evolve, MAX_AGENT_LOG } from '@engin/shared/evolve';
import { reconcileSelection, toProjection, writeProjectionToState } from '@engin/shared/projection-helpers';

// ── Store + types under test ────────────────────────────────────────────────
import type { AgentEntity, EventRecord, TaskEntity, WorkflowProjection } from '../protocol-types';
import { useWorkflowStore } from './workflow-store';

const here = dirname(fileURLToPath(import.meta.url)); // packages/web/src/store

/** Read the workflow-store source (this directory). */
function readSrc(): string {
  return readFileSync(join(here, 'workflow-store.ts'), 'utf8');
}

// ─── Fixture builders ──────────────────────────────────────────────────────

const ISO_NOW = '2026-06-17T00:00:00.000Z';
const SELECTED_RUN = 'run-1';

function blankProjection(overrides?: Partial<WorkflowProjection>): WorkflowProjection {
  return {
    seq: 0,
    taskPrompt: '',
    phases: [],
    currentPhaseId: '',
    completedPhaseIds: [],
    tasks: {},
    agents: {},
    sidebar: { title: '', indicator: '' },
    status: 'running',
    stats: { totalTokens: 0, agentCount: 0 },
    runLog: [],
    ...overrides,
  };
}

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

function evt(
  type: EventRecord['type'],
  data: Record<string, unknown> = {},
  meta: Partial<EventRecord['metadata']> = {},
  seq = 1,
): EventRecord {
  return { seq, type, data, metadata: { timestamp: ISO_NOW, ...meta } };
}

function logEntry(content: string) {
  return {
    id: `log-${content}`,
    timestamp: ISO_NOW,
    type: 'text' as const,
    content,
  };
}

/** Reset the store to a clean initial state. */
function resetStore(): void {
  useWorkflowStore.setState({
    agentsById: {},
    tasksById: {},
    phases: [],
    currentPhaseId: '',
    completedPhaseIds: [],
    sidebar: { title: '', indicator: '' },
    status: 'running',
    taskPrompt: '',
    error: undefined,
    failedPhase: undefined,
    seq: 0,
    stats: { totalTokens: 0, agentCount: 0 },
    workflowEventLog: [],
    selectedPhaseId: null,
    selectedTaskId: null,
    selectedStepIndex: null,
    userPinnedPhase: false,
    userPinnedStep: false,
    runs: [],
    selectedRunId: null,
    runLogs: {},
  });
}

/** Select `run-1` so the (runId-gated) projection actions take effect. */
function selectRunOne(): void {
  useWorkflowStore.setState({ selectedRunId: SELECTED_RUN });
}

/**
 * Project the store's state onto the CANONICAL projection field names — the
 * exact mapping the store's `toProjection` performs (`tasksById` → `tasks`,
 * `agentsById` → `agents`). Returned object satisfies the shared
 * `toProjection`'s `ProjectionFields` input (no `runLog`).
 */
function storeAsProjectionFields(s: ReturnType<typeof useWorkflowStore.getState>) {
  return {
    seq: s.seq,
    taskPrompt: s.taskPrompt,
    phases: s.phases,
    currentPhaseId: s.currentPhaseId,
    completedPhaseIds: s.completedPhaseIds,
    tasks: s.tasksById,
    agents: s.agentsById,
    sidebar: s.sidebar,
    status: s.status,
    error: s.error,
    failedPhase: s.failedPhase,
    stats: s.stats,
  };
}

/** Read the store state fresh (post-action). */
function getState(): ReturnType<typeof useWorkflowStore.getState> {
  return useWorkflowStore.getState();
}

// ═══════════════════════════════════════════════════════════════════════════
// Part A — Source inspection (migration pin)
// ═══════════════════════════════════════════════════════════════════════════

describe('refactor — workflow-store sources projection helpers from @engin/shared', () => {
  it("imports from '@engin/shared/projection-helpers'", () => {
    expect(readSrc()).toContain("from '@engin/shared/projection-helpers'");
  });

  it('imports the directly-used helpers (writeProjectionToState, toProjection, reconcileSelection) as named bindings', () => {
    // Extract the named-import block for the shared module so the assertion is
    // robust to re-ordering / line-wrapping inside the braces.
    const src = readSrc();
    const m = src.match(/import\s*\{([^}]*)\}\s*from\s*['"]@engin\/shared\/projection-helpers['"]/);
    expect(m, 'expected an import from @engin/shared/projection-helpers').not.toBeNull();
    const named = m![1];
    expect(named).toContain('writeProjectionToState');
    expect(named).toContain('toProjection');
    expect(named).toContain('reconcileSelection');
  });

  it('no longer defines a LOCAL capAgentLogs function', () => {
    expect(readSrc()).not.toContain('function capAgentLogs(');
  });

  it('no longer defines a LOCAL toProjection function', () => {
    expect(readSrc()).not.toContain('function toProjection(');
  });

  it('no longer defines a LOCAL writeProjectionToState function', () => {
    expect(readSrc()).not.toContain('function writeProjectionToState(');
  });

  it('no longer defines a LOCAL reconcileSelection function', () => {
    expect(readSrc()).not.toContain('function reconcileSelection(');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Part B — Delegation parity (store observable == shared helper output)
// ═══════════════════════════════════════════════════════════════════════════

describe('refactor — store delegates correctly to the shared helpers', () => {
  beforeEach(() => {
    resetStore();
    selectRunOne();
  });

  // ── writeProjectionToState (+ capAgentLogs via fromSnapshot) parity ───────

  it('applySnapshot output deep-equals shared writeProjectionToState(mirror, snapshot, true)', () => {
    // An OVERSIZED agent log is included on purpose: the snapshot path must cap
    // it. A refactor that forgets `fromSnapshot = true` would leave the log
    // uncapped and this assertion fails (store would differ from the shared
    // helper's capped output).
    const oversized = Array.from({ length: MAX_AGENT_LOG + 5 }, (_, i) => logEntry(`e-${i}`));
    const snapshot = blankProjection({
      seq: 42,
      taskPrompt: 'build it',
      currentPhaseId: 'exec',
      completedPhaseIds: ['plan'],
      phases: [{ id: 'exec', label: 'Exec', icon: '⚡', taskIds: ['t1'] }],
      tasks: { t1: task({ id: 't1', title: 'Task 1', status: 'active', phaseId: 'exec' }) },
      agents: { a1: agent({ uid: 'a1', log: oversized, toolCallCount: 3 }) },
      sidebar: { title: 'App', indicator: 'green' },
      stats: { totalTokens: 1500, agentCount: 1 },
    });

    // What the SHARED helpers produce on a plain mirror (fromSnapshot = true →
    // capAgentLogs is applied to the untrusted external source).
    const mirror: Record<string, unknown> = {};
    writeProjectionToState(mirror, snapshot, true);

    useWorkflowStore.getState().applySnapshot(SELECTED_RUN, snapshot, 42);
    const s = getState();

    // Every container the store exposes must match the shared helper's output.
    expect(s.agentsById).toEqual(mirror['agents']);
    expect(s.tasksById).toEqual(mirror['tasks']);
    expect(s.phases).toEqual(mirror['phases']);
    expect(s.completedPhaseIds).toEqual(mirror['completedPhaseIds']);
    expect(s.sidebar).toEqual(mirror['sidebar']);
    expect(s.stats).toEqual(mirror['stats']);
    expect(s.currentPhaseId).toBe(mirror['currentPhaseId']);
    expect(s.taskPrompt).toBe(mirror['taskPrompt']);
    // Explicit cap check (delegation to shared capAgentLogs via fromSnapshot).
    expect(s.agentsById['a1'].log).toHaveLength(MAX_AGENT_LOG);
    expect(s.agentsById['a1'].log[0].content).toBe('e-5');
    expect(s.agentsById['a1'].log[MAX_AGENT_LOG - 1].content).toBe(`e-${MAX_AGENT_LOG + 4}`);
    expect(s.agentsById['a1'].toolCallCount).toBe(3);
  });

  it('applySnapshot leaves an already-legal agent log uncapped (length === MAX_AGENT_LOG, strict >)', () => {
    // Boundary case for capAgentLogs: length === MAX_AGENT_LOG must NOT be
    // sliced (the cap uses strict >). Both the legacy local helper and the
    // shared helper agree here, pinning the off-by-one boundary.
    const exact = Array.from({ length: MAX_AGENT_LOG }, (_, i) => logEntry(`e-${i}`));
    const snapshot = blankProjection({ agents: { a1: agent({ uid: 'a1', log: exact }) } });
    const mirror: Record<string, unknown> = {};
    writeProjectionToState(mirror, snapshot, true);

    useWorkflowStore.getState().applySnapshot(SELECTED_RUN, snapshot, 1);
    const s = getState();

    expect(s.agentsById).toEqual(mirror['agents']);
    expect(s.agentsById['a1'].log).toHaveLength(MAX_AGENT_LOG);
  });

  // ── writeProjectionToState: defensive shallow copies (mutation isolation) ─

  it('applySnapshot makes defensive copies — mutating the snapshot afterwards does not bleed into the store', () => {
    // Pins the shared helper's defensive-copy contract through the store: each
    // container written into state is a fresh shallow copy, so the untrusted
    // snapshot cannot mutate store state after the fact.
    const snapshot = blankProjection({
      currentPhaseId: 'exec',
      completedPhaseIds: ['plan'],
      phases: [{ id: 'exec', label: 'Exec', icon: '⚡', taskIds: ['t1'] }],
      tasks: { t1: task({ id: 't1', status: 'active', phaseId: 'exec' }) },
      sidebar: { title: 'App', indicator: 'green' },
      stats: { totalTokens: 100, agentCount: 1 },
    });

    useWorkflowStore.getState().applySnapshot(SELECTED_RUN, snapshot, 1);

    // Mutate the ORIGINAL snapshot object after it has been applied.
    snapshot.phases.push({ id: 'review', label: 'Review', icon: '🔍', taskIds: [] });
    snapshot.completedPhaseIds.push('exec');
    snapshot.tasks['t2'] = task({ id: 't2', status: 'ready', phaseId: 'exec' });
    snapshot.sidebar.title = 'CHANGED';
    snapshot.stats.totalTokens = 9999;

    const s = getState();
    expect(s.phases).toHaveLength(1);
    expect(s.phases[0].id).toBe('exec');
    expect(s.completedPhaseIds).toEqual(['plan']);
    expect(Object.keys(s.tasksById)).toEqual(['t1']);
    expect(s.sidebar.title).toBe('App');
    expect(s.stats.totalTokens).toBe(100);
  });

  // ── reconcileSelection parity (full selection tuple) ─────────────────────

  it('selection after applySnapshot matches shared reconcileSelection on an equivalent state (full tuple)', () => {
    const snapshot = blankProjection({
      currentPhaseId: 'exec',
      completedPhaseIds: ['plan'],
      phases: [{ id: 'exec', label: 'Exec', icon: '⚡', taskIds: ['t1', 't2'] }],
      tasks: {
        t1: task({ id: 't1', title: 'T1', status: 'ready', phaseId: 'exec' }),
        t2: task({
          id: 't2',
          title: 'T2',
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

    // Fresh connect: selection starts at null — the SAME seed the store's
    // internal reconcileSelection receives inside applySnapshot.
    useWorkflowStore.setState({
      selectedPhaseId: null,
      selectedTaskId: null,
      selectedStepIndex: null,
      userPinnedPhase: false,
      userPinnedStep: false,
    });
    useWorkflowStore.getState().applySnapshot(SELECTED_RUN, snapshot, 1);
    const s = getState();

    // Mirror the store's post-snapshot projection + the null selection seed,
    // then run the SHARED reconcileSelection directly.
    const mirror = {
      currentPhaseId: s.currentPhaseId,
      completedPhaseIds: s.completedPhaseIds,
      tasks: s.tasksById, // web *ById IS the canonical `tasks` collection
      selectedPhaseId: null as string | null,
      selectedTaskId: null as string | null,
      selectedStepIndex: null as number | null,
      userPinnedPhase: false,
      userPinnedStep: false,
    };
    reconcileSelection(mirror);

    // The store's selection (driven by its own reconcileSelection call) must
    // match the shared helper on the FULL selection tuple.
    expect(s.selectedPhaseId).toBe(mirror.selectedPhaseId);
    expect(s.selectedTaskId).toBe(mirror.selectedTaskId);
    expect(s.selectedStepIndex).toBe(mirror.selectedStepIndex);
    expect(s.userPinnedPhase).toBe(mirror.userPinnedPhase);
    expect(s.userPinnedStep).toBe(mirror.userPinnedStep);
    // Sanity: the shared helper picked the active task + its active step.
    expect(s.selectedPhaseId).toBe('exec');
    expect(s.selectedTaskId).toBe('t2');
    expect(s.selectedStepIndex).toBe(1);
  });

  it('selection after a stale selectedTaskId matches shared reconcileSelection (task re-follow)', () => {
    // Exercises the task-follow branch: selectedTaskId points at a task that no
    // longer belongs to the selected phase → both store and shared helper must
    // re-select the first active task. (Scenario where legacy + shared agree:
    // the task genuinely changes, so both reset the step.)
    const snapshot = blankProjection({
      currentPhaseId: 'exec',
      phases: [{ id: 'exec', label: 'Exec', icon: '⚡', taskIds: ['t1', 't2'] }],
      tasks: {
        t1: task({ id: 't1', title: 'T1', status: 'ready', phaseId: 'exec' }),
        t2: task({ id: 't2', title: 'T2', status: 'active', phaseId: 'exec' }),
      },
    });
    useWorkflowStore.getState().applySnapshot(SELECTED_RUN, snapshot, 1);

    // Force a stale selection, then drive a projection update that re-runs
    // reconcileSelection (applyEvents calls it at the end).
    useWorkflowStore.setState({ selectedPhaseId: 'exec', selectedTaskId: 't-ghost', selectedStepIndex: 9 });
    useWorkflowStore.getState().applyEvents(SELECTED_RUN, [evt('workflow_started', { taskPrompt: 'build' }, {}, 2)]);
    const s = getState();

    const mirror = {
      currentPhaseId: s.currentPhaseId,
      completedPhaseIds: s.completedPhaseIds,
      tasks: s.tasksById,
      selectedPhaseId: 'exec' as string | null,
      selectedTaskId: 't-ghost' as string | null,
      selectedStepIndex: 9 as number | null,
      userPinnedPhase: false,
      userPinnedStep: false,
    };
    reconcileSelection(mirror);

    expect(s.selectedTaskId).toBe(mirror.selectedTaskId);
    expect(s.selectedTaskId).toBe('t2'); // first active in exec
    expect(s.selectedStepIndex).toBe(mirror.selectedStepIndex);
  });

  // ── toProjection + evolve + writeProjectionToState parity (applyEvents) ───

  it('applyEvents result deep-equals evolve(toProjection(storeFields)) written via shared writeProjectionToState', () => {
    // End-to-end delegation parity for the event-folding path:
    //   store:  toProjection(state) → evolve* → writeProjectionToState(state, p)
    //   mirror: toProjection(fields) → evolve* → writeProjectionToState(mirror, p)
    // Both must land identical agentsById/tasksById/seq.
    const seed = blankProjection({
      seq: 5,
      currentPhaseId: 'exec',
      phases: [{ id: 'exec', label: 'Exec', icon: '⚡', taskIds: ['t1'] }],
      tasks: { t1: task({ id: 't1', title: 'T1', status: 'active', phaseId: 'exec' }) },
      agents: { 'a1::t1': agent({ uid: 'a1::t1', agentId: 'a1', taskId: 't1', profile: 'coder' }) },
    });
    useWorkflowStore.getState().applySnapshot(SELECTED_RUN, seed, 5);

    const events: EventRecord[] = [
      evt('task_registered', { id: 't2', title: 'T2', phaseId: 'exec', steps: [], dependencies: [] }, {}, 6),
      evt('agent_spawned', { profile: 'reviewer' }, { agentId: 'a2', taskId: 't2' }, 7),
    ];

    // Replicate the fold with the SHARED helpers, seeded from the store's
    // pre-events state mapped onto canonical projection field names.
    const fieldsBefore = storeAsProjectionFields(getState());
    let projection = toProjection(fieldsBefore);
    for (const event of events) projection = evolve(projection, event);
    const mirror: Record<string, unknown> = {};
    writeProjectionToState(mirror, projection); // fromSnapshot defaults to false (evolve already caps)

    // Drive the store.
    useWorkflowStore.getState().applyEvents(SELECTED_RUN, events);
    const s = getState();

    expect(s.agentsById).toEqual(mirror['agents']);
    expect(s.tasksById).toEqual(mirror['tasks']);
    expect(s.phases).toEqual(mirror['phases']);
    expect(s.currentPhaseId).toBe(mirror['currentPhaseId']);
    expect(s.seq).toBe(projection.seq);
    // Carry-over (seeded from current state via toProjection) + new entities.
    expect(Object.keys(s.tasksById).sort()).toEqual(['t1', 't2']);
    expect(Object.keys(s.agentsById).sort()).toEqual(['a1::t1', 'a2::t2']);
    expect(s.agentsById['a2::t2'].profile).toBe('reviewer');
  });
});
