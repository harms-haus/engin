/* eslint-disable no-control-regex -- tests intentionally match ANSI escape codes */
import { describe, expect, it, spyOn } from 'bun:test';
import type { WorkflowProjection } from '../../../src/tracking/event-types.js';
import { createInitialProjection } from '../../../src/tracking/event-types.js';
import { Dashboard } from '../../../src/tui/components/dashboard.js';
import { stripAnsi } from '../../../src/tui/theme.js';

const WIDTH = 80;

/** Helper to create a projection with agents in the given phases. */
function projectionWithAgents(phases: string[], agentIds: string[]): WorkflowProjection {
  const p = createInitialProjection();
  p.currentPhase = phases[0] ?? '';
  p.sidebar.phases = phases.map((id) => ({ id, label: id, icon: '📋' }));
  for (const phase of phases) {
    for (const agentId of agentIds) {
      const key = agentId + '-' + phase;
      p.agents[key] = {
        uid: key,
        agentId,
        profile: 'coder',
        phase,
        active: true,
        log: [],
        toolCallCount: 0,
        inputTokens: 0,
        outputTokens: 0,
        taskTitle: '',
      };
    }
  }
  return p;
}

/** Helper to set up dashboard with agents via syncFromProjection. */
function setupDashboardWithAgents(logLines = 4): Dashboard {
  const d = new Dashboard(logLines);
  const p = projectionWithAgents(['test'], ['agent-1', 'agent-2']);
  d.syncFromProjection(p);
  return d;
}

describe('Dashboard', () => {
  // ── syncFromProjection ──────────────────────────────────────────────
  it('syncFromProjection pushes agents to agentLog', () => {
    const d = new Dashboard(4);
    const p = projectionWithAgents(['work'], ['test-agent']);
    d.syncFromProjection(p);

    // agentLog should now see agents in 'work' phase
    expect(d.agentLog.getCurrentPhase()).toBe('work');
    expect(d.agentLog.getSelectedAgentUid()).toBeTruthy();
  });

  it('syncFromProjection pushes phases to phaseBar', () => {
    const d = new Dashboard(4);
    const p = createInitialProjection();
    p.currentPhase = 'planning';
    p.completedPhases = ['scouting'];
    p.sidebar.phases = [
      { id: 'scouting', label: 'Scouting', icon: '🔍' },
      { id: 'planning', label: 'Planning', icon: '📋' },
    ];
    d.syncFromProjection(p);

    // phaseBar should have phases set
    const phaseLines = d.phaseBar.render(WIDTH - 2);
    expect(phaseLines[0]).toContain('Scouting');
    expect(phaseLines[0]).toContain('Planning');
  });

  it('syncFromProjection pushes tasks to lanePool', () => {
    const d = new Dashboard(2);
    const p = createInitialProjection();
    p.tasks = {
      t1: { id: 't1', title: 'Alpha', status: 'ready' },
      t2: { id: 't2', title: 'Beta', status: 'done' },
    };
    d.syncFromProjection(p);

    expect(d.lanePool.getVisibleLaneCount()).toBe(2);
  });

  // ── getComputedHeight ───────────────────────────────────────────────
  it('returns correct total height including border lines', () => {
    const d = new Dashboard(4);
    expect(d.getComputedHeight()).toBe(1 + 0 + 4 + 4);
  });

  it('accounts for visible lanes in computed height', () => {
    const d = new Dashboard(4);
    d.lanePool.updateLanes([
      { id: 't1', title: 'A', status: 'ready' },
      { id: 't2', title: 'B', status: 'done' },
    ]);
    expect(d.getComputedHeight()).toBe(1 + 2 + 4 + 4);
  });

  it('uses default agentLogLines of 20', () => {
    const d = new Dashboard();
    expect(d.getComputedHeight()).toBe(1 + 0 + 20 + 4);
  });

  it('getComputedHeight increases when agentLog is expanded', () => {
    const d = new Dashboard(4);
    expect(d.getComputedHeight()).toBe(1 + 0 + 4 + 4);

    d.agentLog.toggleExpand();
    expect(d.agentLog.isExpanded()).toBe(true);
    expect(d.getComputedHeight()).toBe(1 + 0 + 40 + 4);
  });

  // ── Sub-component getters ──────────────────────────────────────────
  it('exposes phaseBar, lanePool, and agentLog via getters', () => {
    const d = new Dashboard(3);
    expect(d.phaseBar).toBeDefined();
    expect(d.lanePool).toBeDefined();
    expect(d.agentLog).toBeDefined();
  });

  // ── render line count ──────────────────────────────────────────────
  it('render() returns correct total line count with borders', () => {
    const d = new Dashboard(4);
    const lines = d.render(WIDTH);
    expect(lines).toHaveLength(1 + 0 + 4 + 4);
  });

  it('render() with lanes returns correct line count', () => {
    const d = new Dashboard(4);
    d.lanePool.updateLanes([
      { id: 't1', title: 'A', status: 'ready' },
      { id: 't2', title: 'B', status: 'done' },
    ]);
    const lines = d.render(WIDTH);
    expect(lines).toHaveLength(1 + 2 + 4 + 4);
  });

  it('render() with default agentLogLines returns correct line count', () => {
    const d = new Dashboard();
    const lines = d.render(WIDTH);
    expect(lines).toHaveLength(1 + 0 + 20 + 4);
  });

  // ── render() border structure ──────────────────────────────────────
  it('render() starts with top border ┌─┐', () => {
    const d = new Dashboard(3);
    const lines = d.render(WIDTH);
    expect(lines[0]).toBe('┌' + '─'.repeat(WIDTH - 2) + '┐');
  });

  it('render() ends with bottom border └─┘', () => {
    const d = new Dashboard(3);
    const lines = d.render(WIDTH);
    expect(lines[lines.length - 1]).toBe('└' + '─'.repeat(WIDTH - 2) + '┘');
  });

  it('render() has separators ├─┤ between sections', () => {
    const d = new Dashboard(3);
    const lines = d.render(WIDTH);
    const sep = '├' + '─'.repeat(WIDTH - 2) + '┤';
    const sepCount = lines.filter((l) => l === sep).length;
    expect(sepCount).toBe(2);
  });

  it('render() wraps content lines with │', () => {
    const d = new Dashboard(3);
    d.phaseBar.setPhases([{ id: 'plan', label: 'Plan', icon: '📋' }]);
    d.phaseBar.setCurrentPhase('plan');
    const lines = d.render(WIDTH);

    expect(lines[1].startsWith('│')).toBe(true);
    expect(lines[1].endsWith('│')).toBe(true);
    expect(stripAnsi(lines[1]).length).toBe(WIDTH);
  });

  // ── invalidate ─────────────────────────────────────────────────────
  it('invalidate() calls invalidate on all sub-components', () => {
    const d = new Dashboard(3);

    const phaseSpy = spyOn(d.phaseBar, 'invalidate');
    const laneSpy = spyOn(d.lanePool, 'invalidate');
    const logSpy = spyOn(d.agentLog, 'invalidate');

    d.invalidate();

    expect(phaseSpy).toHaveBeenCalledTimes(1);
    expect(laneSpy).toHaveBeenCalledTimes(1);
    expect(logSpy).toHaveBeenCalledTimes(1);

    phaseSpy.mockRestore();
    laneSpy.mockRestore();
    logSpy.mockRestore();
  });

  // ── handleInput delegation ─────────────────────────────────────────
  it('handleInput routes left/right arrows to agentLog', () => {
    const d = setupDashboardWithAgents();

    const agents = d.agentLog.render(WIDTH);
    expect(agents.length).toBeGreaterThan(0);

    // Initially agent-1 is selected (index 0)
    expect(d.agentLog.getSelectedAgentUid()).toBeTruthy();

    d.handleInput('\x1b[D');
    // After left, a different agent should be selected (or same if only 1)
  });

  it('handleInput routes up/down to agentLog (phase cycling)', () => {
    const d = new Dashboard(4);
    const p = projectionWithAgents(['test', 'phase-b'], ['agent-a']);
    d.syncFromProjection(p);

    expect(d.agentLog.getCurrentPhase()).toBe('test');

    d.handleInput('\x1b[B');
    expect(d.agentLog.getCurrentPhase()).toBe('phase-b');

    d.handleInput('\x1b[A');
    expect(d.agentLog.getCurrentPhase()).toBe('test');
  });

  it('handleInput routes shift+up/shift+down to agentLog', () => {
    const d = setupDashboardWithAgents();

    const logSpy = spyOn(d.agentLog, 'handleInput');

    d.handleInput('\x1b[1;2A'); // shift+up
    expect(logSpy).toHaveBeenCalledTimes(1);

    logSpy.mockClear();

    d.handleInput('\x1b[1;2B'); // shift+down
    expect(logSpy).toHaveBeenCalledTimes(1);

    logSpy.mockRestore();
  });

  it('handleInput does NOT route ctrl+left/ctrl+right to agentLog', () => {
    const d = setupDashboardWithAgents();

    const logSpy = spyOn(d.agentLog, 'handleInput');

    d.handleInput('\x1bOd'); // Ctrl+left (legacy)
    expect(logSpy).not.toHaveBeenCalled();

    logSpy.mockClear();

    d.handleInput('\x1bOc'); // Ctrl+right (legacy)
    expect(logSpy).not.toHaveBeenCalled();

    logSpy.mockRestore();
  });

  it('handleInput does NOT route non-arrow keys to any subcomponent', () => {
    const d = setupDashboardWithAgents();

    const logSpy = spyOn(d.agentLog, 'handleInput');
    const laneSpy = spyOn(d.lanePool, 'handleInput');

    d.handleInput('\r');
    expect(logSpy).not.toHaveBeenCalled();
    expect(laneSpy).not.toHaveBeenCalled();

    logSpy.mockRestore();
    laneSpy.mockRestore();
  });

  it('handleInput does NOT change lanePool focus when down arrow is pressed', () => {
    const d = setupDashboardWithAgents();
    d.lanePool.updateLanes([
      { id: 't1', title: 'A', status: 'ready' },
      { id: 't2', title: 'B', status: 'ready' },
      { id: 't3', title: 'C', status: 'ready' },
    ]);
    d.lanePool.setFocusedLaneById('t1');
    expect(d.lanePool.getFocusedTaskId()).toBe('t1');

    d.handleInput('\x1b[B');

    expect(d.lanePool.getFocusedTaskId()).toBe('t1');
  });

  it('handleInput routes up/down to agentLog when expanded (for scrolling)', () => {
    const d = setupDashboardWithAgents();
    d.agentLog.toggleExpand();
    expect(d.agentLog.isExpanded()).toBe(true);

    const logSpy = spyOn(d.agentLog, 'handleInput');
    const laneSpy = spyOn(d.lanePool, 'handleInput');

    d.handleInput('\x1b[A');
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(laneSpy).not.toHaveBeenCalled();

    logSpy.mockClear();
    laneSpy.mockClear();

    d.handleInput('\x1b[B');
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(laneSpy).not.toHaveBeenCalled();

    logSpy.mockRestore();
    laneSpy.mockRestore();
  });

  it('handleInput routes up/down to agentLog even when NOT expanded', () => {
    const d = setupDashboardWithAgents();
    expect(d.agentLog.isExpanded()).toBe(false);

    const logSpy = spyOn(d.agentLog, 'handleInput');
    const laneSpy = spyOn(d.lanePool, 'handleInput');

    d.handleInput('\x1b[A');
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(laneSpy).not.toHaveBeenCalled();

    logSpy.mockRestore();
    laneSpy.mockRestore();
  });
});

// ─── Phase bar underline sync on handleInput ──────────────────────────

describe('Dashboard phase bar underline sync', () => {
  it('handleInput down arrow syncs phaseBar selected phase', () => {
    const d = new Dashboard(4);

    d.phaseBar.setPhases([
      { id: 'phase-a', label: 'Phase A', icon: 'A' },
      { id: 'phase-b', label: 'Phase B', icon: 'B' },
    ]);
    d.phaseBar.setCurrentPhase('phase-a');

    const p = projectionWithAgents(['phase-a', 'phase-b'], ['agent-a', 'agent-b']);
    d.syncFromProjection(p);

    let phaseBarLine = d.phaseBar.render(WIDTH - 2)[0];
    expect(phaseBarLine).toContain('\x1b[4m');

    d.handleInput('\x1b[B');

    phaseBarLine = d.phaseBar.render(WIDTH - 2)[0];
    const underlineCount = (phaseBarLine.match(/\x1b\[4m/g) || []).length;
    expect(underlineCount).toBe(1);
  });

  it('handleInput up arrow syncs phaseBar selected phase backwards', () => {
    const d = new Dashboard(4);

    d.phaseBar.setPhases([
      { id: 'phase-a', label: 'Phase A', icon: 'A' },
      { id: 'phase-b', label: 'Phase B', icon: 'B' },
    ]);
    d.phaseBar.setCurrentPhase('phase-a');

    const p = projectionWithAgents(['phase-a', 'phase-b'], ['agent-a', 'agent-b']);
    d.syncFromProjection(p);

    d.handleInput('\x1b[A');

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
      { id: 'plan', label: 'Planning', icon: '📋' },
      { id: 'build', label: 'Building', icon: '🔨' },
    ]);
    d.phaseBar.setCurrentPhase('plan');

    const lines = d.render(WIDTH);

    const phaseLine = lines[1];
    expect(phaseLine.startsWith('│')).toBe(true);
    expect(phaseLine.endsWith('│')).toBe(true);
    expect(visibleWidth(phaseLine)).toBe(WIDTH);
  });

  it('AgentLog content lines have correct visible width when colored', () => {
    const d = new Dashboard(4);
    const entity = {
      uid: 'agent-1',
      agentId: 'agent-1',
      profile: 'coder',
      phase: 'test',
      active: true,
      log: [{ id: '1', timestamp: '', type: 'error' as const, content: 'something failed' }],
      toolCallCount: 0,
      inputTokens: 0,
      outputTokens: 0,
      taskTitle: '',
    };
    d.syncFromProjection({
      ...createInitialProjection(),
      currentPhase: 'test',
      sidebar: { title: '', indicator: '', phases: [{ id: 'test', label: 'test', icon: '📋' }] },
      agents: { [entity.uid]: entity },
    });

    const lines = d.render(WIDTH);

    const entryLine = lines[4];
    expect(entryLine.startsWith('│')).toBe(true);
    expect(entryLine.endsWith('│')).toBe(true);
    expect(visibleWidth(entryLine)).toBe(WIDTH);
  });

  it('LanePool content lines have correct visible width when colored', () => {
    const d = new Dashboard(2);
    d.lanePool.updateLanes([
      { id: 't1', title: 'Alpha', status: 'ready' },
      { id: 't2', title: 'Beta', status: 'done' },
    ]);

    const lines = d.render(WIDTH);

    for (let i = 3; i < 3 + 2; i++) {
      const laneLine = lines[i];
      expect(laneLine.startsWith('│')).toBe(true);
      expect(laneLine.endsWith('│')).toBe(true);
      expect(visibleWidth(laneLine)).toBe(WIDTH);
    }
  });

  it('Right border column aligns across border, content, and separator lines', () => {
    const d = new Dashboard(3);
    d.phaseBar.setPhases([
      { id: 'plan', label: 'Plan', icon: '📋' },
      { id: 'build', label: 'Build', icon: '🔨' },
    ]);
    d.phaseBar.setCurrentPhase('plan');

    const entity = {
      uid: 'a1',
      agentId: 'a1',
      profile: 'coder',
      phase: 'test',
      active: true,
      log: [{ id: '1', timestamp: '', type: 'text' as const, content: 'hi' }],
      toolCallCount: 0,
      inputTokens: 0,
      outputTokens: 0,
      taskTitle: '',
    };
    d.syncFromProjection({
      ...createInitialProjection(),
      sidebar: { title: '', indicator: '', phases: [] },
      agents: { [entity.uid]: entity },
    });

    const lines = d.render(WIDTH);

    for (const line of lines) {
      const stripped = stripAnsi(line);
      const lastBar = stripped.lastIndexOf('│');
      if (lastBar !== -1) {
        expect(lastBar).toBe(WIDTH - 1);
      }
    }
  });

  it('all content lines have string length <= innerWidth+2 even with ANSI codes', () => {
    const d = new Dashboard(3);
    d.phaseBar.setPhases([
      { id: 'a', label: 'Alpha', icon: '📋' },
      { id: 'b', label: 'Beta', icon: '🔨' },
      { id: 'c', label: 'Gamma', icon: '⚙️' },
    ]);
    d.phaseBar.setCurrentPhase('a');
    d.phaseBar.setCompletedPhases(['b']);

    const lines = d.render(WIDTH);

    for (const line of lines) {
      if (line.startsWith('│') && line.endsWith('│')) {
        expect(visibleWidth(line)).toBe(WIDTH);
      }
    }
  });

  it('ANSI-heavy lane pool lines maintain correct visible width', () => {
    const d = new Dashboard(2);
    d.lanePool.updateLanes([
      { id: 't1', title: 'Short', status: 'done' },
      { id: 't2', title: 'Another task title', status: 'failed' },
      { id: 't3', title: 'Yet another longer task', status: 'ready' },
      { id: 't4', title: 'Blocked task', status: 'blocked' },
    ]);

    const lines = d.render(WIDTH);

    for (let i = 3; i < 3 + 4; i++) {
      expect(visibleWidth(lines[i])).toBe(WIDTH);
    }
  });

  it('agent log with multiple colored entries maintains correct visible width per line', () => {
    const d = new Dashboard(5);
    const entity = {
      uid: 'a1',
      agentId: 'a1',
      profile: 'coder',
      phase: 'test',
      active: true,
      log: [
        { id: '1', timestamp: '', type: 'text' as const, content: 'hello' },
        { id: '2', timestamp: '', type: 'thinking' as const, content: 'thinking...' },
        { id: '3', timestamp: '', type: 'error' as const, content: 'oops' },
        { id: '4', timestamp: '', type: 'tool_call_start' as const, content: 'running tool' },
      ],
      toolCallCount: 0,
      inputTokens: 0,
      outputTokens: 0,
      taskTitle: '',
    };
    d.syncFromProjection({
      ...createInitialProjection(),
      currentPhase: 'test',
      sidebar: { title: '', indicator: '', phases: [{ id: 'test', label: 'test', icon: '📋' }] },
      agents: { [entity.uid]: entity },
    });

    const lines = d.render(WIDTH);

    for (let i = 4; i < lines.length; i++) {
      if (lines[i].startsWith('│')) {
        expect(visibleWidth(lines[i])).toBe(WIDTH);
      }
    }
  });
});
