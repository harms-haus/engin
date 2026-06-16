/* eslint-disable no-control-regex -- tests intentionally match ANSI escape codes */
import type { AgentEntity, LogEntry, TaskEntity, WorkflowProjection } from '@engin/shared';
import { createInitialProjection } from '@engin/shared';
import { describe, expect, it, spyOn } from 'bun:test';
import { Dashboard } from '../../../packages/tui/src/components/dashboard.js';
import { stripAnsi } from '../../../packages/tui/src/theme.js';

const WIDTH = 80;

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Create a minimal TaskEntity. */
function makeTask(overrides: Partial<TaskEntity> & { id: string }): TaskEntity {
  return {
    title: 'Test Task',
    phaseId: 'phase-a',
    status: 'ready',
    steps: [],
    dependencies: [],
    ...overrides,
  };
}

/** Create a minimal AgentEntity for the given task and phase. */
function makeAgent(uid: string, taskId: string, phaseId: string, overrides: Partial<AgentEntity> = {}): AgentEntity {
  return {
    uid,
    agentId: uid,
    profile: 'coder',
    phaseId,
    taskId,
    active: true,
    log: [],
    toolCallCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    taskTitle: '',
    ...overrides,
  };
}

/** Build a full projection with phases, tasks, and agents. */
function buildProjection(options: {
  phases?: { id: string; label?: string; icon?: string }[];
  currentPhaseId?: string;
  completedPhaseIds?: string[];
  tasks?: TaskEntity[];
  agents?: AgentEntity[];
  indicator?: string;
}): WorkflowProjection {
  const p = createInitialProjection();
  p.phases = (options.phases ?? []).map((ph) => ({
    id: ph.id,
    label: ph.label ?? ph.id,
    icon: ph.icon ?? '📋',
    taskIds: [],
  }));
  p.currentPhaseId = options.currentPhaseId ?? '';
  p.completedPhaseIds = options.completedPhaseIds ?? [];
  for (const t of options.tasks ?? []) {
    p.tasks[t.id] = t;
  }
  for (const a of options.agents ?? []) {
    p.agents[a.uid] = a;
  }
  if (options.indicator) {
    p.sidebar.indicator = options.indicator;
  }
  return p;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('Dashboard', () => {
  // ── syncFromProjection: selection state ─────────────────────────────

  describe('syncFromProjection — selection', () => {
    it('sets selectedPhaseId to currentPhaseId when null', () => {
      const d = new Dashboard(4);
      const p = buildProjection({
        phases: [{ id: 'alpha' }, { id: 'beta' }],
        currentPhaseId: 'beta',
      });
      d.syncFromProjection(p);
      expect(d.getSelection().selectedPhaseId).toBe('beta');
    });

    it('follows currentPhaseId when selectedPhaseId is not completed and differs', () => {
      const d = new Dashboard(4);
      const p1 = buildProjection({
        phases: [{ id: 'alpha' }, { id: 'beta' }],
        currentPhaseId: 'alpha',
      });
      d.syncFromProjection(p1);

      // user manually navigates to 'beta' (non-completed, not current)
      // Since selectedPhaseId is non-null we simulate a prior selection
      // by setting it directly via the selection (not normally exposed)
      // We'll use the left/right input to navigate to beta
      d.handleInput('\x1b[C'); // right → should go to beta

      // Now sync with currentPhaseId still = alpha and beta not completed
      const p2 = buildProjection({
        phases: [{ id: 'alpha' }, { id: 'beta' }],
        currentPhaseId: 'alpha',
      });
      d.syncFromProjection(p2);

      // selectedPhaseId was 'beta' (non-completed, differs from current 'alpha')
      // → follow rule overrides to 'alpha'
      expect(d.getSelection().selectedPhaseId).toBe('alpha');
    });

    it('keeps selectedPhaseId when it is a completed phase (reviewing history)', () => {
      const d = new Dashboard(4);
      const p = buildProjection({
        phases: [{ id: 'alpha' }, { id: 'beta' }],
        currentPhaseId: 'beta',
        completedPhaseIds: ['alpha'],
      });
      d.syncFromProjection(p);

      // Navigate left to completed phase 'alpha'
      d.handleInput('\x1b[D');

      // Sync again with same projection
      d.syncFromProjection(p);

      // Since 'alpha' is completed, the follow rule keeps it pinned
      expect(d.getSelection().selectedPhaseId).toBe('alpha');
    });

    it('auto-selects first active task when selectedTaskId is null', () => {
      const d = new Dashboard(4);
      const p = buildProjection({
        phases: [{ id: 'phase-a' }],
        currentPhaseId: 'phase-a',
        tasks: [
          makeTask({ id: 't1', phaseId: 'phase-a', status: 'ready' }),
          makeTask({ id: 't2', phaseId: 'phase-a', status: 'active', steps: [], startedAt: Date.now() }),
          makeTask({ id: 't3', phaseId: 'phase-a', status: 'ready' }),
        ],
      });
      d.syncFromProjection(p);
      expect(d.getSelection().selectedTaskId).toBe('t2');
    });

    it('auto-selects first task when no active task exists', () => {
      const d = new Dashboard(4);
      const p = buildProjection({
        phases: [{ id: 'phase-a' }],
        currentPhaseId: 'phase-a',
        tasks: [
          makeTask({ id: 't1', phaseId: 'phase-a', status: 'ready' }),
          makeTask({ id: 't2', phaseId: 'phase-a', status: 'complete' }),
        ],
      });
      d.syncFromProjection(p);
      // t1 is first in creation order
      expect(d.getSelection().selectedTaskId).toBe('t1');
    });

    it('keeps selectedTaskId when it exists in phaseTasks', () => {
      const d = new Dashboard(4);
      const p = buildProjection({
        phases: [{ id: 'phase-a' }],
        currentPhaseId: 'phase-a',
        tasks: [
          makeTask({ id: 't1', phaseId: 'phase-a', status: 'ready' }),
          makeTask({ id: 't2', phaseId: 'phase-a', status: 'active', startedAt: Date.now() }),
        ],
      });
      d.syncFromProjection(p);
      // auto-selects t2 (active) because it's the first active task
      expect(d.getSelection().selectedTaskId).toBe('t2');

      // Navigate up to t1 via handleInput (up arrow collapses to taskList).
      // Creation order: [t1 (ready), t2 (active)]; t2 is at index 1, so up goes to t1
      d.handleInput('\x1b[A');
      expect(d.getSelection().selectedTaskId).toBe('t1');

      // Re-sync with same tasks — should keep t1 since it's still in phaseTasks
      d.syncFromProjection(p);
      expect(d.getSelection().selectedTaskId).toBe('t1');
    });

    it('follows activeStepIndex when selectedStepIndex matches and not pinned', () => {
      const d = new Dashboard(4);
      const p = buildProjection({
        phases: [{ id: 'phase-a' }],
        currentPhaseId: 'phase-a',
        tasks: [
          makeTask({
            id: 't1',
            phaseId: 'phase-a',
            status: 'active',
            activeStepIndex: 0,
            steps: [
              { name: 'Step 1', index: 0 },
              { name: 'Step 2', index: 1 },
            ],
            startedAt: Date.now(),
          }),
        ],
      });
      d.syncFromProjection(p);
      expect(d.getSelection().selectedStepIndex).toBe(0);

      // Advance activeStepIndex
      const p2 = buildProjection({
        phases: [{ id: 'phase-a' }],
        currentPhaseId: 'phase-a',
        tasks: [
          makeTask({
            id: 't1',
            phaseId: 'phase-a',
            status: 'active',
            activeStepIndex: 1,
            steps: [
              { name: 'Step 1', index: 0 },
              { name: 'Step 2', index: 1 },
            ],
            startedAt: Date.now(),
          }),
        ],
      });
      d.syncFromProjection(p2);
      // selectedStepIndex was 0 (matched old activeStepIndex 0), not pinned → follow to 1
      expect(d.getSelection().selectedStepIndex).toBe(1);
    });

    it('keeps selectedStepIndex when userPinnedStep is true', () => {
      const d = new Dashboard(4);
      const p = buildProjection({
        phases: [{ id: 'phase-a' }],
        currentPhaseId: 'phase-a',
        tasks: [
          makeTask({
            id: 't1',
            phaseId: 'phase-a',
            status: 'active',
            activeStepIndex: 0,
            steps: [
              { name: 'Step 1', index: 0 },
              { name: 'Step 2', index: 1 },
            ],
            startedAt: Date.now(),
          }),
        ],
      });
      d.syncFromProjection(p);

      // Pin step to index 1 via tab key (steps need agentKey for tab cycling)
      // First re-build projection with agentKey on both steps
      const pWithKeys = buildProjection({
        phases: [{ id: 'phase-a' }],
        currentPhaseId: 'phase-a',
        tasks: [
          makeTask({
            id: 't1',
            phaseId: 'phase-a',
            status: 'active',
            activeStepIndex: 0,
            steps: [
              { name: 'Step 1', index: 0, agentKey: 'a1' },
              { name: 'Step 2', index: 1, agentKey: 'a2' },
            ],
            startedAt: Date.now(),
          }),
        ],
        agents: [makeAgent('a1', 't1', 'phase-a'), makeAgent('a2', 't1', 'phase-a')],
      });
      d.syncFromProjection(pWithKeys);

      // Now tab to cycle to step index 1
      d.handleInput('\t');
      expect(d.getSelection().selectedStepIndex).toBe(1);
      expect(d.getSelection().userPinnedStep).toBe(true);

      // Now advance activeStepIndex (keep the same task with same steps)
      const p2 = buildProjection({
        phases: [{ id: 'phase-a' }],
        currentPhaseId: 'phase-a',
        tasks: [
          makeTask({
            id: 't1',
            phaseId: 'phase-a',
            status: 'active',
            activeStepIndex: 1,
            steps: [
              { name: 'Step 1', index: 0 },
              { name: 'Step 2', index: 1 },
            ],
            startedAt: Date.now(),
          }),
        ],
      });
      d.syncFromProjection(p2);
      // userPinnedStep = true → should keep 1 (which now equals activeStepIndex, but that's coincidence)
      expect(d.getSelection().selectedStepIndex).toBe(1);
      expect(d.getSelection().userPinnedStep).toBe(true);
    });
  });

  // ── syncFromProjection: widget updates ──────────────────────────────

  describe('syncFromProjection — widget updates', () => {
    it('pushes phases to phaseBar', () => {
      const d = new Dashboard(4);
      const p = buildProjection({
        phases: [
          { id: 'scouting', label: 'Scouting', icon: '🔍' },
          { id: 'planning', label: 'Planning', icon: '📋' },
        ],
        currentPhaseId: 'planning',
        completedPhaseIds: ['scouting'],
        indicator: '🚀',
      });
      d.syncFromProjection(p);

      const phaseLines = d.phaseBar.render(WIDTH - 2);
      expect(phaseLines[0]).toContain('Scouting');
      expect(phaseLines[0]).toContain('Planning');
      expect(phaseLines[0]).toContain('🚀');
    });

    it('pushes tasks to taskList filtered by selected phase', () => {
      const d = new Dashboard(2);
      const p = buildProjection({
        phases: [{ id: 'phase-a' }, { id: 'phase-b' }],
        currentPhaseId: 'phase-a',
        tasks: [
          makeTask({ id: 't1', phaseId: 'phase-a', status: 'ready' }),
          makeTask({ id: 't2', phaseId: 'phase-b', status: 'complete' }),
        ],
      });
      d.syncFromProjection(p);

      // Only phase-a tasks should appear
      expect(d.taskList.getVisibleTaskCount()).toBe(1);
    });

    it('pushes steps and agents to agentLog for selected task', () => {
      const d = new Dashboard(4);
      const p = buildProjection({
        phases: [{ id: 'phase-a' }],
        currentPhaseId: 'phase-a',
        tasks: [
          makeTask({
            id: 't1',
            phaseId: 'phase-a',
            status: 'active',
            activeStepIndex: 0,
            steps: [
              { name: 'Init', index: 0, agentKey: 'agent-1' },
              { name: 'Build', index: 1, agentKey: 'agent-2' },
            ],
            startedAt: Date.now(),
          }),
        ],
        agents: [
          makeAgent('agent-1', 't1', 'phase-a'),
          makeAgent('agent-2', 't1', 'phase-a'),
          makeAgent('agent-other', 't2', 'phase-a'), // different task, should be filtered out
        ],
      });
      d.syncFromProjection(p);

      // agentLog should have 2 agents (filtered by taskId + phaseId)
      // We can't directly inspect agentLog's internal state, but we can check
      // that the selected agent uid is one of the expected ones
      expect(d.agentLog.getSelectedAgentUid()).toBe('agent-1');
    });

    it('calls invalidate on all sub-widgets', () => {
      const d = new Dashboard(4);
      const phaseSpy = spyOn(d.phaseBar, 'invalidate');
      const taskSpy = spyOn(d.taskList, 'invalidate');
      const logSpy = spyOn(d.agentLog, 'invalidate');

      const p = buildProjection({
        phases: [{ id: 'phase-a' }],
        currentPhaseId: 'phase-a',
      });
      d.syncFromProjection(p);

      expect(phaseSpy).toHaveBeenCalledTimes(1);
      expect(taskSpy).toHaveBeenCalledTimes(1);
      expect(logSpy).toHaveBeenCalledTimes(1);

      phaseSpy.mockRestore();
      taskSpy.mockRestore();
      logSpy.mockRestore();
    });
  });

  // ── getComputedHeight ──────────────────────────────────────────────

  describe('getComputedHeight', () => {
    it('returns correct total height including border lines', () => {
      const d = new Dashboard(4);
      // 1 (phaseBar) + 0 (tasks) + 4 (agentLog collapsed) + 4 (borders) = 9
      expect(d.getComputedHeight()).toBe(1 + 0 + 4 + 4);
    });

    it('accounts for visible tasks in computed height', () => {
      const d = new Dashboard(4);
      d.taskList.updateTasks([
        makeTask({ id: 't1', phaseId: 'a', status: 'ready' }),
        makeTask({ id: 't2', phaseId: 'a', status: 'complete' }),
      ]);
      expect(d.getComputedHeight()).toBe(1 + 2 + 4 + 4);
    });

    it('uses default agentLogLines of 20', () => {
      const d = new Dashboard();
      expect(d.getComputedHeight()).toBe(1 + 0 + 20 + 4);
    });

    it('increases when agentLog is expanded', () => {
      const d = new Dashboard(4);
      expect(d.getComputedHeight()).toBe(1 + 0 + 4 + 4);

      d.agentLog.toggleExpand();
      expect(d.agentLog.isExpanded()).toBe(true);
      expect(d.getComputedHeight()).toBe(1 + 0 + 40 + 4);
    });
  });

  // ── Sub-component getters ──────────────────────────────────────────

  describe('getters', () => {
    it('exposes phaseBar, taskList, and agentLog', () => {
      const d = new Dashboard(3);
      expect(d.phaseBar).toBeDefined();
      expect(d.taskList).toBeDefined();
      expect(d.agentLog).toBeDefined();
    });

    it('getSelection returns a readonly copy', () => {
      const d = new Dashboard(3);
      const sel = d.getSelection();
      expect(sel.selectedPhaseId).toBeNull();
      expect(sel.selectedTaskId).toBeNull();
      expect(sel.selectedStepIndex).toBeNull();
      expect(sel.userPinnedPhase).toBe(false);
      expect(sel.userPinnedStep).toBe(false);

      // Mutating the returned copy should not affect internal state
      (sel as any).selectedPhaseId = 'changed';
      expect(d.getSelection().selectedPhaseId).toBeNull();
    });
  });

  // ── forceReselect ──────────────────────────────────────────────────

  describe('forceReselect', () => {
    it('resets taskId, stepIndex and userPinnedStep', () => {
      const d = new Dashboard(4);

      // Set up some selection state
      const p = buildProjection({
        phases: [{ id: 'phase-a' }],
        currentPhaseId: 'phase-a',
        tasks: [
          makeTask({
            id: 't1',
            phaseId: 'phase-a',
            status: 'active',
            activeStepIndex: 0,
            steps: [{ name: 'Step 1', index: 0 }],
            startedAt: Date.now(),
          }),
        ],
      });
      d.syncFromProjection(p);

      // Tab to pin the step (sets userPinnedStep = true)
      d.handleInput('\t');

      d.forceReselect();

      const after = d.getSelection();
      expect(after.selectedTaskId).toBeNull();
      expect(after.selectedStepIndex).toBeNull();
      expect(after.userPinnedStep).toBe(false);
      // Phase is preserved
      expect(after.selectedPhaseId).toBe('phase-a');
    });
  });

  // ── render line count ──────────────────────────────────────────────

  describe('render — line counts', () => {
    it('returns correct total line count with borders', () => {
      const d = new Dashboard(4);
      const lines = d.render(WIDTH);
      expect(lines).toHaveLength(1 + 0 + 4 + 4);
    });

    it('with tasks returns correct line count', () => {
      const d = new Dashboard(4);
      d.taskList.updateTasks([
        makeTask({ id: 't1', phaseId: 'a', status: 'ready' }),
        makeTask({ id: 't2', phaseId: 'a', status: 'complete' }),
      ]);
      const lines = d.render(WIDTH);
      expect(lines).toHaveLength(1 + 2 + 4 + 4);
    });

    it('with default agentLogLines returns correct line count', () => {
      const d = new Dashboard();
      const lines = d.render(WIDTH);
      expect(lines).toHaveLength(1 + 0 + 20 + 4);
    });
  });

  // ── render border structure ────────────────────────────────────────

  describe('render — border structure', () => {
    it('starts with top border ┌─┐', () => {
      const d = new Dashboard(3);
      const lines = d.render(WIDTH);
      expect(lines[0]).toBe('┌' + '─'.repeat(WIDTH - 2) + '┐');
    });

    it('ends with bottom border └─┘', () => {
      const d = new Dashboard(3);
      const lines = d.render(WIDTH);
      expect(lines[lines.length - 1]).toBe('└' + '─'.repeat(WIDTH - 2) + '┘');
    });

    it('has separators ├─┤ between sections', () => {
      const d = new Dashboard(3);
      const lines = d.render(WIDTH);
      const sep = '├' + '─'.repeat(WIDTH - 2) + '┤';
      const sepCount = lines.filter((l) => l === sep).length;
      expect(sepCount).toBe(2);
    });

    it('wraps content lines with │', () => {
      const d = new Dashboard(3);
      d.phaseBar.setPhases([{ id: 'plan', label: 'Plan', icon: '📋', taskIds: [] }]);
      d.phaseBar.setCurrentPhaseId('plan');
      const lines = d.render(WIDTH);

      expect(lines[1].startsWith('│')).toBe(true);
      expect(lines[1].endsWith('│')).toBe(true);
      expect(stripAnsi(lines[1]).length).toBe(WIDTH);
    });
  });

  // ── invalidate ─────────────────────────────────────────────────────

  describe('invalidate', () => {
    it('calls invalidate on all sub-components', () => {
      const d = new Dashboard(3);

      const phaseSpy = spyOn(d.phaseBar, 'invalidate');
      const taskSpy = spyOn(d.taskList, 'invalidate');
      const logSpy = spyOn(d.agentLog, 'invalidate');

      d.invalidate();

      expect(phaseSpy).toHaveBeenCalledTimes(1);
      expect(taskSpy).toHaveBeenCalledTimes(1);
      expect(logSpy).toHaveBeenCalledTimes(1);

      phaseSpy.mockRestore();
      taskSpy.mockRestore();
      logSpy.mockRestore();
    });
  });

  // ── handleInput routing ───────────────────────────────────────────

  describe('handleInput — routing', () => {
    it('routes left/right to phaseBar', () => {
      const d = new Dashboard(4);
      const p = buildProjection({
        phases: [{ id: 'alpha' }, { id: 'beta' }],
        currentPhaseId: 'alpha',
      });
      d.syncFromProjection(p);

      const phaseSpy = spyOn(d.phaseBar, 'handleInput');

      d.handleInput('\x1b[D'); // left
      expect(phaseSpy).toHaveBeenCalledTimes(1);
      expect(phaseSpy).toHaveBeenCalledWith('\x1b[D');

      phaseSpy.mockClear();
      d.handleInput('\x1b[C'); // right
      expect(phaseSpy).toHaveBeenCalledTimes(1);
      expect(phaseSpy).toHaveBeenCalledWith('\x1b[C');

      phaseSpy.mockRestore();
    });

    it('left/right updates selectedPhaseId', () => {
      const d = new Dashboard(4);
      const p = buildProjection({
        phases: [{ id: 'alpha' }, { id: 'beta' }],
        currentPhaseId: 'alpha',
      });
      d.syncFromProjection(p);
      expect(d.getSelection().selectedPhaseId).toBe('alpha');

      d.handleInput('\x1b[C'); // right → beta
      expect(d.getSelection().selectedPhaseId).toBe('beta');

      d.handleInput('\x1b[D'); // left → alpha
      expect(d.getSelection().selectedPhaseId).toBe('alpha');
    });

    it('left/right wraps around at boundaries', () => {
      const d = new Dashboard(4);
      const p = buildProjection({
        phases: [{ id: 'alpha' }, { id: 'beta' }, { id: 'gamma' }],
        currentPhaseId: 'alpha',
      });
      d.syncFromProjection(p);

      // At first phase, left wraps to last
      d.handleInput('\x1b[D');
      expect(d.getSelection().selectedPhaseId).toBe('gamma');

      // At last phase, right wraps to first
      d.handleInput('\x1b[C');
      expect(d.getSelection().selectedPhaseId).toBe('alpha');
    });

    it('left/right resets task and step selection on phase change', () => {
      const d = new Dashboard(4);
      const p = buildProjection({
        phases: [{ id: 'alpha' }, { id: 'beta' }],
        currentPhaseId: 'alpha',
      });
      // Set up task/step state via projection + tab pin
      const pWithTask = buildProjection({
        phases: [{ id: 'alpha' }, { id: 'beta' }],
        currentPhaseId: 'alpha',
        tasks: [makeTask({ id: 'some-task', phaseId: 'alpha', status: 'ready' })],
      });
      d.syncFromProjection(pWithTask);
      d.handleInput('\t'); // pin step

      d.handleInput('\x1b[C'); // right → beta

      const after = d.getSelection();
      expect(after.selectedTaskId).toBeNull();
      expect(after.selectedStepIndex).toBeNull();
      expect(after.userPinnedStep).toBe(false);
    });

    it('routes up/down to taskList when agentLog is collapsed', () => {
      const d = new Dashboard(4);
      const p = buildProjection({
        phases: [{ id: 'phase-a' }],
        currentPhaseId: 'phase-a',
        tasks: [
          makeTask({ id: 't1', phaseId: 'phase-a', status: 'ready' }),
          makeTask({ id: 't2', phaseId: 'phase-a', status: 'active', steps: [], startedAt: Date.now() }),
        ],
      });
      d.syncFromProjection(p);

      expect(d.agentLog.isExpanded()).toBe(false);

      const taskSpy = spyOn(d.taskList, 'handleInput');
      const logSpy = spyOn(d.agentLog, 'handleInput');

      d.handleInput('\x1b[A'); // up
      expect(taskSpy).toHaveBeenCalledTimes(1);
      expect(logSpy).not.toHaveBeenCalled();

      taskSpy.mockClear();
      logSpy.mockClear();

      d.handleInput('\x1b[B'); // down
      expect(taskSpy).toHaveBeenCalledTimes(1);
      expect(logSpy).not.toHaveBeenCalled();

      taskSpy.mockRestore();
      logSpy.mockRestore();
    });

    it('routes up/down to agentLog when expanded', () => {
      const d = new Dashboard(4);
      const p = buildProjection({
        phases: [{ id: 'phase-a' }],
        currentPhaseId: 'phase-a',
        tasks: [
          makeTask({
            id: 't1',
            phaseId: 'phase-a',
            status: 'active',
            activeStepIndex: 0,
            steps: [{ name: 'Step 1', index: 0, agentKey: 'a1' }],
            startedAt: Date.now(),
          }),
        ],
        agents: [makeAgent('a1', 't1', 'phase-a')],
      });
      d.syncFromProjection(p);
      d.agentLog.toggleExpand();
      expect(d.agentLog.isExpanded()).toBe(true);

      const taskSpy = spyOn(d.taskList, 'handleInput');
      const logSpy = spyOn(d.agentLog, 'handleInput');

      d.handleInput('\x1b[A'); // up
      expect(logSpy).toHaveBeenCalledTimes(1);
      expect(taskSpy).not.toHaveBeenCalled();

      logSpy.mockClear();

      d.handleInput('\x1b[B'); // down
      expect(logSpy).toHaveBeenCalledTimes(1);
      expect(taskSpy).not.toHaveBeenCalled();

      taskSpy.mockRestore();
      logSpy.mockRestore();
    });

    it('up/down when expanded scrolls agent log without resetting scroll offset', () => {
      const d = new Dashboard(10);

      // Build a projection with one phase, one active task with 50+ log entries
      const logEntries: LogEntry[] = [];
      for (let i = 0; i < 50; i++) {
        logEntries.push({ id: `${i}`, timestamp: '', type: 'text', content: `entry-${i}` });
      }

      const p = buildProjection({
        phases: [{ id: 'phase-a' }],
        currentPhaseId: 'phase-a',
        tasks: [
          makeTask({
            id: 't1',
            phaseId: 'phase-a',
            status: 'active',
            activeStepIndex: 0,
            steps: [{ name: 'Step 1', index: 0, agentKey: 'a1' }],
            startedAt: Date.now(),
          }),
        ],
        agents: [
          makeAgent('a1', 't1', 'phase-a', {
            log: logEntries,
          }),
        ],
      });
      d.syncFromProjection(p);

      // Toggle expand
      d.agentLog.toggleExpand();
      expect(d.agentLog.isExpanded()).toBe(true);

      // Render once to initialize _lastTotalEntryLines
      d.agentLog.render(80);

      // Press up arrow — should increment scroll offset to 1
      d.handleInput('\x1b[A');
      const lines1 = d.agentLog.render(80);
      expect(lines1[1]).toContain('up arrow');

      // Press up arrow again — should increment scroll offset to 2
      d.handleInput('\x1b[A');
      const lines2 = d.agentLog.render(80);
      expect(lines2[1]).toContain('up arrow 2');
    });

    it('routes shift+up/shift+down to agentLog only when expanded', () => {
      const d = new Dashboard(4);
      const p = buildProjection({
        phases: [{ id: 'phase-a' }],
        currentPhaseId: 'phase-a',
        tasks: [
          makeTask({
            id: 't1',
            phaseId: 'phase-a',
            status: 'active',
            activeStepIndex: 0,
            steps: [{ name: 'Step 1', index: 0, agentKey: 'a1' }],
            startedAt: Date.now(),
          }),
        ],
        agents: [makeAgent('a1', 't1', 'phase-a')],
      });
      d.syncFromProjection(p);

      const logSpy = spyOn(d.agentLog, 'handleInput');

      // When collapsed, shift+up/down should NOT route
      expect(d.agentLog.isExpanded()).toBe(false);

      d.handleInput('\x1b[1;2A'); // shift+up
      expect(logSpy).not.toHaveBeenCalled();

      logSpy.mockClear();

      d.handleInput('\x1b[1;2B'); // shift+down
      expect(logSpy).not.toHaveBeenCalled();

      logSpy.mockClear();

      // When expanded, shift+up/down SHOULD route
      d.agentLog.toggleExpand();
      expect(d.agentLog.isExpanded()).toBe(true);

      d.handleInput('\x1b[1;2A'); // shift+up
      expect(logSpy).toHaveBeenCalledTimes(1);

      logSpy.mockClear();

      d.handleInput('\x1b[1;2B'); // shift+down
      expect(logSpy).toHaveBeenCalledTimes(1);

      logSpy.mockRestore();
    });

    it('tab cycles agent step and updates agentLog selection', () => {
      const d = new Dashboard(4);
      const p = buildProjection({
        phases: [{ id: 'phase-a' }],
        currentPhaseId: 'phase-a',
        tasks: [
          makeTask({
            id: 't1',
            phaseId: 'phase-a',
            status: 'active',
            activeStepIndex: 0,
            steps: [
              { name: 'Step 1', index: 0, agentKey: 'a1' },
              { name: 'Step 2', index: 1, agentKey: 'a2' },
            ],
            startedAt: Date.now(),
          }),
        ],
        agents: [makeAgent('a1', 't1', 'phase-a'), makeAgent('a2', 't1', 'phase-a')],
      });
      d.syncFromProjection(p);

      // Initial selection follows activeStepIndex 0 → agent a1
      expect(d.agentLog.getSelectedAgentUid()).toBe('a1');

      // Tab → cycle to next step (index 1) → agent a2
      d.handleInput('\t');
      expect(d.agentLog.getSelectedAgentUid()).toBe('a2');
      expect(d.getSelection().selectedStepIndex).toBe(1);

      // Tab again → wrap around to step index 0 → agent a1
      d.handleInput('\t');
      expect(d.agentLog.getSelectedAgentUid()).toBe('a1');
      expect(d.getSelection().selectedStepIndex).toBe(0);

      // Shift+Tab → backward to step index 1 → agent a2
      d.handleInput('\x1b[Z');
      expect(d.agentLog.getSelectedAgentUid()).toBe('a2');
      expect(d.getSelection().selectedStepIndex).toBe(1);
    });

    it('tab sets userPinnedStep to true', () => {
      const d = new Dashboard(4);
      const p = buildProjection({
        phases: [{ id: 'phase-a' }],
        currentPhaseId: 'phase-a',
        tasks: [
          makeTask({
            id: 't1',
            phaseId: 'phase-a',
            status: 'active',
            activeStepIndex: 0,
            steps: [
              { name: 'Step 1', index: 0, agentKey: 'a1' },
              { name: 'Step 2', index: 1, agentKey: 'a2' },
            ],
            startedAt: Date.now(),
          }),
        ],
        agents: [makeAgent('a1', 't1', 'phase-a'), makeAgent('a2', 't1', 'phase-a')],
      });
      d.syncFromProjection(p);

      expect(d.getSelection().userPinnedStep).toBe(false);

      d.handleInput('\t'); // tab → userPinnedStep = true

      expect(d.getSelection().userPinnedStep).toBe(true);
    });

    it('does NOT route non-arrow/non-tab keys to any subcomponent', () => {
      const d = new Dashboard(4);
      const p = buildProjection({
        phases: [{ id: 'phase-a' }],
        currentPhaseId: 'phase-a',
        tasks: [makeTask({ id: 't1', phaseId: 'phase-a', status: 'ready' })],
      });
      d.syncFromProjection(p);

      const phaseSpy = spyOn(d.phaseBar, 'handleInput');
      const taskSpy = spyOn(d.taskList, 'handleInput');
      const logSpy = spyOn(d.agentLog, 'handleInput');

      d.handleInput('\r'); // enter
      expect(phaseSpy).not.toHaveBeenCalled();
      expect(taskSpy).not.toHaveBeenCalled();
      expect(logSpy).not.toHaveBeenCalled();

      d.handleInput('a'); // letter
      expect(phaseSpy).not.toHaveBeenCalled();
      expect(taskSpy).not.toHaveBeenCalled();
      expect(logSpy).not.toHaveBeenCalled();

      d.handleInput('\x1b'); // lone escape
      expect(phaseSpy).not.toHaveBeenCalled();
      expect(taskSpy).not.toHaveBeenCalled();
      expect(logSpy).not.toHaveBeenCalled();

      phaseSpy.mockRestore();
      taskSpy.mockRestore();
      logSpy.mockRestore();
    });
  });

  // ── handleInput: task list navigation ──────────────────────────────

  describe('handleInput — task list navigation', () => {
    it('up/down collapsed changes selectedTaskId via taskList', () => {
      const d = new Dashboard(4);
      const p = buildProjection({
        phases: [{ id: 'phase-a' }],
        currentPhaseId: 'phase-a',
        tasks: [
          makeTask({ id: 't1', phaseId: 'phase-a', status: 'ready' }),
          makeTask({ id: 't2', phaseId: 'phase-a', status: 'active', steps: [], startedAt: Date.now() }),
          makeTask({ id: 't3', phaseId: 'phase-a', status: 'ready' }),
        ],
      });
      d.syncFromProjection(p);

      // Creation/registration order: [t1 (ready), t2 (active), t3 (ready)].
      // Task-follow auto-selects the first active task (t2) at index 1.

      // Initially selects t2 (first active task in creation order)
      expect(d.getSelection().selectedTaskId).toBe('t2');

      // Down → t3 (index 2)
      d.handleInput('\x1b[B');
      expect(d.getSelection().selectedTaskId).toBe('t3');

      // Down stays at t3 (last)
      d.handleInput('\x1b[B');
      expect(d.getSelection().selectedTaskId).toBe('t3');

      // Up → t2 (index 1)
      d.handleInput('\x1b[A');
      expect(d.getSelection().selectedTaskId).toBe('t2');

      // Up → t1 (index 0)
      d.handleInput('\x1b[A');
      expect(d.getSelection().selectedTaskId).toBe('t1');

      // Up stays at t1 (first)
      d.handleInput('\x1b[A');
      expect(d.getSelection().selectedTaskId).toBe('t1');
    });

    it('task change via up/down resets step selection', () => {
      const d = new Dashboard(4);
      const p = buildProjection({
        phases: [{ id: 'phase-a' }],
        currentPhaseId: 'phase-a',
        tasks: [
          makeTask({
            id: 't1',
            phaseId: 'phase-a',
            status: 'active',
            activeStepIndex: 0,
            steps: [{ name: 'S1', index: 0 }],
            startedAt: Date.now(),
          }),
          makeTask({
            id: 't2',
            phaseId: 'phase-a',
            status: 'active',
            activeStepIndex: 0,
            steps: [{ name: 'S1', index: 0 }],
            startedAt: Date.now(),
          }),
        ],
      });
      d.syncFromProjection(p);

      // Select t1 (first active), step follows
      expect(d.getSelection().selectedTaskId).toBe('t1');
      expect(d.getSelection().selectedStepIndex).toBe(0);

      // Down to t2
      d.handleInput('\x1b[B');

      const after = d.getSelection();
      expect(after.selectedTaskId).toBe('t2');
      // Step follows to t2's activeStepIndex immediately (no longer deferred to
      // the next sync) so the agent log re-renders without waiting for an event.
      expect(after.selectedStepIndex).toBe(0);
      expect(after.userPinnedStep).toBe(false);
    });
  });
});

// ─── Phase bar underline sync ───────────────────────────────────────────

describe('Dashboard phase bar underline sync', () => {
  it('handleInput left/right updates phaseBar selected phase', () => {
    const d = new Dashboard(4);

    const p = buildProjection({
      phases: [
        { id: 'phase-a', label: 'Phase A', icon: 'A' },
        { id: 'phase-b', label: 'Phase B', icon: 'B' },
      ],
      currentPhaseId: 'phase-a',
    });
    d.syncFromProjection(p);

    // Phase A should be underlined (it's the current/selected)
    let phaseBarLine = d.phaseBar.render(WIDTH - 2)[0];
    expect(phaseBarLine).toContain('\x1b[4m');

    d.handleInput('\x1b[C'); // right to phase-b

    phaseBarLine = d.phaseBar.render(WIDTH - 2)[0];
    const underlineCount = (phaseBarLine.match(/\x1b\[4m/g) || []).length;
    expect(underlineCount).toBe(1);
  });

  it('handleInput left cycles phaseBar selection', () => {
    const d = new Dashboard(4);

    const p = buildProjection({
      phases: [
        { id: 'phase-a', label: 'Phase A', icon: 'A' },
        { id: 'phase-b', label: 'Phase B', icon: 'B' },
      ],
      currentPhaseId: 'phase-a',
    });
    d.syncFromProjection(p);

    d.handleInput('\x1b[D'); // left from phase-a wraps to phase-b

    const phaseBarLine = d.phaseBar.render(WIDTH - 2)[0];
    const underlineCount = (phaseBarLine.match(/\x1b\[4m/g) || []).length;
    expect(underlineCount).toBe(1);
  });
});

// ─── ANSI-aware border padding ───────────────────────────────────────────

describe('Dashboard ANSI-aware border padding', () => {
  const visibleWidth = (s: string): number => stripAnsi(s).length;

  it('PhaseBar content lines have correct visible width when colored', () => {
    const d = new Dashboard(3);
    d.phaseBar.setPhases([
      { id: 'plan', label: 'Planning', icon: '📋', taskIds: [] },
      { id: 'build', label: 'Building', icon: '🔨', taskIds: [] },
    ]);
    d.phaseBar.setCurrentPhaseId('plan');

    const lines = d.render(WIDTH);

    const phaseLine = lines[1];
    expect(phaseLine.startsWith('│')).toBe(true);
    expect(phaseLine.endsWith('│')).toBe(true);
    expect(visibleWidth(phaseLine)).toBe(WIDTH);
  });

  it('TaskList content lines have correct visible width when colored', () => {
    const d = new Dashboard(2);
    d.taskList.updateTasks([
      makeTask({ id: 't1', phaseId: 'a', status: 'ready' }),
      makeTask({ id: 't2', phaseId: 'a', status: 'complete' }),
    ]);

    const lines = d.render(WIDTH);

    for (let i = 3; i < 3 + 2; i++) {
      const taskLine = lines[i];
      expect(taskLine.startsWith('│')).toBe(true);
      expect(taskLine.endsWith('│')).toBe(true);
      expect(visibleWidth(taskLine)).toBe(WIDTH);
    }
  });

  it('AgentLog content lines have correct visible width when colored', () => {
    const d = new Dashboard(4);
    const p = buildProjection({
      phases: [{ id: 'test' }],
      currentPhaseId: 'test',
      tasks: [
        makeTask({
          id: 't1',
          phaseId: 'test',
          status: 'active',
          activeStepIndex: 0,
          steps: [{ name: 'Step 1', index: 0, agentKey: 'a1' }],
          startedAt: Date.now(),
        }),
      ],
      agents: [
        makeAgent('a1', 't1', 'test', {
          log: [{ id: '1', timestamp: '', type: 'error' as const, content: 'something failed' }],
        }),
      ],
    });
    d.syncFromProjection(p);

    const lines = d.render(WIDTH);

    // Find a content line that has '│' (skip borders/separators)
    const contentLine = lines.find((l) => l.startsWith('│') && l.includes('failed'));
    expect(contentLine).toBeDefined();
    expect(contentLine!.startsWith('│')).toBe(true);
    expect(contentLine!.endsWith('│')).toBe(true);
    expect(visibleWidth(contentLine!)).toBe(WIDTH);
  });

  it('Right border column aligns across all line types', () => {
    const d = new Dashboard(3);
    const p = buildProjection({
      phases: [
        { id: 'plan', label: 'Plan', icon: '📋' },
        { id: 'build', label: 'Build', icon: '🔨' },
      ],
      currentPhaseId: 'plan',
      tasks: [
        makeTask({
          id: 't1',
          phaseId: 'plan',
          status: 'active',
          activeStepIndex: 0,
          steps: [{ name: 'Step 1', index: 0, agentKey: 'a1' }],
          startedAt: Date.now(),
        }),
      ],
      agents: [
        makeAgent('a1', 't1', 'plan', {
          log: [{ id: '1', timestamp: '', type: 'text' as const, content: 'hi' }],
        }),
      ],
    });
    d.syncFromProjection(p);

    const lines = d.render(WIDTH);

    for (const line of lines) {
      const stripped = stripAnsi(line);
      const lastBar = stripped.lastIndexOf('│');
      if (lastBar !== -1) {
        expect(lastBar).toBe(WIDTH - 1);
      }
    }
  });

  it('ANSI-heavy task list lines maintain correct visible width', () => {
    const d = new Dashboard(2);
    d.taskList.updateTasks([
      makeTask({ id: 't1', phaseId: 'a', status: 'complete' }),
      makeTask({ id: 't2', phaseId: 'a', status: 'failed' }),
      makeTask({ id: 't3', phaseId: 'a', status: 'ready' }),
      makeTask({ id: 't4', phaseId: 'a', status: 'blocked' }),
    ]);

    const lines = d.render(WIDTH);

    for (let i = 3; i < 3 + 4; i++) {
      expect(visibleWidth(lines[i])).toBe(WIDTH);
    }
  });

  it('all content lines have correct visible width even with ANSI codes', () => {
    const d = new Dashboard(3);
    d.phaseBar.setPhases([
      { id: 'a', label: 'Alpha', icon: '📋', taskIds: [] },
      { id: 'b', label: 'Beta', icon: '🔨', taskIds: [] },
      { id: 'c', label: 'Gamma', icon: '⚙️', taskIds: [] },
    ]);
    d.phaseBar.setCurrentPhaseId('a');
    d.phaseBar.setCompletedPhaseIds(['b']);

    const lines = d.render(WIDTH);

    for (const line of lines) {
      if (line.startsWith('│') && line.endsWith('│')) {
        expect(visibleWidth(line)).toBe(WIDTH);
      }
    }
  });
});
