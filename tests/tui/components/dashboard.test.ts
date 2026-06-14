import { describe, expect, it, spyOn } from 'bun:test';
import { Dashboard } from '../../../src/tui/components/dashboard.js';
import { stripAnsi } from '../../../src/tui/theme.js';

const WIDTH = 80;

/** Helper to set up dashboard with two agents in the same phase for navigation tests. */
function setupDashboardWithAgents(logLines = 4): Dashboard {
  const d = new Dashboard(logLines);
  d.registry.register({
    agentId: 'agent-1',
    profile: 'coder',
    phase: 'test',
  });
  d.registry.register({
    agentId: 'agent-2',
    profile: 'scout',
    phase: 'test',
  });
  d.agentLog.setPhases(['test']);
  d.agentLog.setCurrentPhase('test');
  return d;
}

describe('Dashboard', () => {
  // ── registry getter ──────────────────────────────────────────────────
  it('dashboard.registry getter returns the AgentRegistry instance', () => {
    const d = new Dashboard(4);
    expect(d.registry).toBeDefined();
    expect(typeof d.registry.register).toBe('function');
    expect(typeof d.registry.getAgents).toBe('function');
  });

  it('dashboard.registry is shared with agentLog', () => {
    const d = new Dashboard(4);

    // Register an agent via dashboard.registry
    const uid = d.registry.register({
      agentId: 'test-agent',
      profile: 'tester',
      phase: 'work',
    });

    // Set up the agentLog to view this agent
    d.agentLog.setPhases(['work']);
    d.agentLog.setCurrentPhase('work');

    // Add an entry via registry
    d.registry.addEntry(uid, { type: 'text', content: 'hello from test' });

    // Render and verify the agent data appears in the rendered output
    const lines = d.agentLog.render(40);
    expect(lines[0]).toContain('tester');
    expect(lines[1]).toContain('hello from test');
  });

  // ── getComputedHeight ───────────────────────────────────────────────
  it('returns correct total height including border lines', () => {
    const d = new Dashboard(4);
    // PhaseBar renders 1 line, 0 lanes, agentLogLines=4
    // content = 1 + 0 + 4 = 5, + 4 borders = 9
    expect(d.getComputedHeight()).toBe(1 + 0 + 4 + 4);
  });

  it('accounts for visible lanes in computed height', () => {
    const d = new Dashboard(4);
    d.lanePool.updateLanes([
      { id: 't1', title: 'A', status: 'ready' },
      { id: 't2', title: 'B', status: 'done' },
    ]);
    // PhaseBar=1, lanes=2, agentLog=4 => content=7, +4 borders=11
    expect(d.getComputedHeight()).toBe(1 + 2 + 4 + 4);
  });

  it('uses default agentLogLines of 20', () => {
    const d = new Dashboard();
    // PhaseBar=1, lanes=0, agentLog=20 => content=21, +4 borders=25
    expect(d.getComputedHeight()).toBe(1 + 0 + 20 + 4);
  });

  it('getComputedHeight increases when agentLog is expanded', () => {
    const d = new Dashboard(4);
    // Not expanded: agentLog.getExpandedLineCount() returns maxLines = 4
    // PhaseBar=1, lanes=0, agentLog=4 => content=5, +4 borders=9
    expect(d.getComputedHeight()).toBe(1 + 0 + 4 + 4);

    // Expand: agentLog.getExpandedLineCount() returns _expandedLineCount = 40
    d.agentLog.toggleExpand();
    expect(d.agentLog.isExpanded()).toBe(true);
    // PhaseBar=1, lanes=0, agentLog=40 => content=41, +4 borders=45
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
    // PhaseBar=1, lanes=0 (no lanes set), agentLog=4 => content=5, +4 borders=9
    expect(lines).toHaveLength(1 + 0 + 4 + 4);
  });

  it('render() with lanes returns correct line count', () => {
    const d = new Dashboard(4);
    d.lanePool.updateLanes([
      { id: 't1', title: 'A', status: 'ready' },
      { id: 't2', title: 'B', status: 'done' },
    ]);
    const lines = d.render(WIDTH);
    // PhaseBar=1, lanes=2, agentLog=4 => content=7, +4 borders=11
    expect(lines).toHaveLength(1 + 2 + 4 + 4);
  });

  it('render() with default agentLogLines returns correct line count', () => {
    const d = new Dashboard();
    const lines = d.render(WIDTH);
    // PhaseBar=1, lanes=0, agentLog=20 => content=21, +4 borders=25
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

    // Phase content line (index 1)
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

    // Get the UIDs
    const agent1Uid = d.registry.getActiveUid('agent-1');
    const agent2Uid = d.registry.getActiveUid('agent-2');

    // Initially agent-1 is selected (index 0)
    expect(d.agentLog.getSelectedAgentUid()).toBe(agent1Uid);

    // Left arrow should go to agent-2 (wrapping)
    d.handleInput('\x1b[D');
    expect(d.agentLog.getSelectedAgentUid()).toBe(agent2Uid);

    // Right arrow should go back to agent-1
    d.handleInput('\x1b[C');
    expect(d.agentLog.getSelectedAgentUid()).toBe(agent1Uid);
  });

  it('handleInput routes up/down to agentLog (phase cycling)', () => {
    const d = setupDashboardWithAgents();

    // Set up multiple phases for cycling
    d.registry.register({
      agentId: 'phase-b-agent',
      profile: 'tester',
      phase: 'phase-b',
    });
    d.agentLog.setPhases(['test', 'phase-b']);
    d.agentLog.setCurrentPhase('test');
    expect(d.agentLog.getCurrentPhase()).toBe('test');

    // Down arrow should cycle to next phase
    d.handleInput('\x1b[B');
    expect(d.agentLog.getCurrentPhase()).toBe('phase-b');

    // Up arrow should cycle back to test
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

    // Ctrl+left and Ctrl+right should no longer be handled
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

    // 'enter' key should not be routed to either
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

    // Down arrow now goes to agentLog (phase cycling), not lanePool
    d.handleInput('\x1b[B');

    // LanePool focus should be unchanged
    expect(d.lanePool.getFocusedTaskId()).toBe('t1');
  });

  it('handleInput routes up/down to agentLog when expanded (for scrolling)', () => {
    const d = setupDashboardWithAgents();
    d.agentLog.toggleExpand();
    expect(d.agentLog.isExpanded()).toBe(true);

    const logSpy = spyOn(d.agentLog, 'handleInput');
    const laneSpy = spyOn(d.lanePool, 'handleInput');

    d.handleInput('\x1b[A'); // Up arrow
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(laneSpy).not.toHaveBeenCalled();

    logSpy.mockClear();
    laneSpy.mockClear();

    d.handleInput('\x1b[B'); // Down arrow
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(laneSpy).not.toHaveBeenCalled();

    logSpy.mockRestore();
    laneSpy.mockRestore();
  });

  it('handleInput routes up/down to agentLog even when NOT expanded', () => {
    const d = setupDashboardWithAgents();
    // Ensure agentLog is NOT expanded
    expect(d.agentLog.isExpanded()).toBe(false);

    const logSpy = spyOn(d.agentLog, 'handleInput');
    const laneSpy = spyOn(d.lanePool, 'handleInput');

    d.handleInput('\x1b[A'); // Up arrow
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

    // Set up phases on phase bar
    d.phaseBar.setPhases([
      { id: 'phase-a', label: 'Phase A', icon: 'A' },
      { id: 'phase-b', label: 'Phase B', icon: 'B' },
    ]);
    d.phaseBar.setCurrentPhase('phase-a');

    // Register agents in both phases
    d.registry.register({
      agentId: 'agent-a',
      profile: 'coder',
      phase: 'phase-a',
    });
    d.registry.register({
      agentId: 'agent-b',
      profile: 'scout',
      phase: 'phase-b',
    });
    d.agentLog.setPhases(['phase-a', 'phase-b']);
    d.agentLog.setCurrentPhase('phase-a');

    // Initially, Phase A should be underlined (current phase, no explicit selection)
    let phaseBarLine = d.phaseBar.render(WIDTH - 2)[0];
    expect(phaseBarLine).toContain('\x1b[4m');

    // Down arrow: agent log cycles to phase-b
    d.handleInput('\x1b[B');

    // Phase bar should now underline Phase B
    phaseBarLine = d.phaseBar.render(WIDTH - 2)[0];
    // eslint-disable-next-line no-control-regex
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

    d.registry.register({
      agentId: 'agent-a',
      profile: 'coder',
      phase: 'phase-a',
    });
    d.registry.register({
      agentId: 'agent-b',
      profile: 'scout',
      phase: 'phase-b',
    });
    d.agentLog.setPhases(['phase-a', 'phase-b']);
    d.agentLog.setCurrentPhase('phase-a');

    // Up arrow from phase-a wraps to phase-b (cycling backwards)
    d.handleInput('\x1b[A');

    // Phase bar should now underline Phase B
    const phaseBarLine = d.phaseBar.render(WIDTH - 2)[0];
    // eslint-disable-next-line no-control-regex
    const underlineCount = (phaseBarLine.match(/\x1b\[4m/g) || []).length;
    expect(underlineCount).toBe(1);
  });
});

// ─── ANSI-aware border padding ───────────────────────────────────────────
// The dashboard must account for ANSI escape codes when padding/truncating
// content lines so that the right border '│' ends up at the correct visible
// column.  padEnd/slice treat ANSI bytes as characters, producing content
// lines whose visible width is shorter than expected.

describe('Dashboard ANSI-aware border padding', () => {
  /**
   * Helper: strip ANSI escapes from a string and return its visible length.
   */
  const visibleWidth = (s: string): number => stripAnsi(s).length;

  it('PhaseBar content lines have correct visible width when colored', () => {
    const d = new Dashboard(3);
    d.phaseBar.setPhases([
      { id: 'plan', label: 'Planning', icon: '📋' },
      { id: 'build', label: 'Building', icon: '🔨' },
    ]);
    d.phaseBar.setCurrentPhase('plan');

    const lines = d.render(WIDTH);

    // PhaseBar renders exactly 1 line (index 1 after top border)
    const phaseLine = lines[1];
    expect(phaseLine.startsWith('│')).toBe(true);
    expect(phaseLine.endsWith('│')).toBe(true);
    // Visible width must equal total width — the right border '│' must be
    // at the same visible column as in a border line.
    expect(visibleWidth(phaseLine)).toBe(WIDTH);
  });

  it('AgentLog content lines have correct visible width when colored', () => {
    const d = new Dashboard(4);
    // Register an agent via registry
    const uid = d.registry.register({
      agentId: 'agent-1',
      profile: 'coder',
      phase: 'test',
    });
    d.agentLog.setPhases(['test']);
    d.agentLog.setCurrentPhase('test');
    d.registry.addEntry(uid, { type: 'error', content: 'something failed' });
    d.agentLog.invalidate();

    const lines = d.render(WIDTH);

    // Agent log content starts after: top(1) + phase(1) + sep(1) + sep(1)
    // = index 4.  The first entry with ⚠️ is at index 4.
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

    // Lane content starts after: top(1) + phase(1) + sep(1) = index 3
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

    // Register an agent via registry
    const uid = d.registry.register({
      agentId: 'a1',
      profile: 'coder',
      phase: 'test',
    });
    d.agentLog.setPhases(['test']);
    d.agentLog.setCurrentPhase('test');
    d.registry.addEntry(uid, { type: 'text', content: 'hi' });
    d.agentLog.invalidate();

    const lines = d.render(WIDTH);

    // For every line that contains '│', the visible position of the LAST
    // '│' should be at column WIDTH-1 (0-indexed).
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

    // Every content line wrapped with │ should have visible width = WIDTH
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

    // Each lane line (indices 3-6) should have correct visible width
    for (let i = 3; i < 3 + 4; i++) {
      expect(visibleWidth(lines[i])).toBe(WIDTH);
    }
  });

  it('agent log with multiple colored entries maintains correct visible width per line', () => {
    const d = new Dashboard(5);
    // Register an agent via registry
    const uid = d.registry.register({
      agentId: 'a1',
      profile: 'coder',
      phase: 'test',
    });
    d.agentLog.setPhases(['test']);
    d.agentLog.setCurrentPhase('test');
    d.registry.addEntry(uid, { type: 'text', content: 'hello' });
    d.registry.addEntry(uid, { type: 'thinking', content: 'thinking...' });
    d.registry.addEntry(uid, { type: 'error', content: 'oops' });
    d.registry.addEntry(uid, { type: 'tool_call_start', content: 'running tool' });
    d.agentLog.invalidate();

    const lines = d.render(WIDTH);

    // All agent log lines (header + entries + empty) should have correct visible width
    for (let i = 4; i < lines.length; i++) {
      if (lines[i].startsWith('│')) {
        expect(visibleWidth(lines[i])).toBe(WIDTH);
      }
    }
  });
});
