import { describe, expect, it, spyOn } from 'bun:test';
import { Dashboard } from '../../../src/tui/components/dashboard.js';
import { stripAnsi } from '../../../src/tui/theme.js';

const WIDTH = 80;

describe('Dashboard', () => {
  // ── getComputedHeight ───────────────────────────────────────────────
  it('returns correct total height including border lines', () => {
    const d = new Dashboard(3, 4);
    // PhaseBar renders 1 line, 0 lanes, agentLogLines=4
    // content = 1 + 0 + 4 = 5, + 4 borders = 9
    expect(d.getComputedHeight()).toBe(1 + 0 + 4 + 4);
  });

  it('accounts for visible lanes in computed height', () => {
    const d = new Dashboard(3, 4);
    d.lanePool.updateLanes([
      { id: 't1', title: 'A', status: 'ready' },
      { id: 't2', title: 'B', status: 'done' },
    ]);
    // PhaseBar=1, lanes=2, agentLog=4 => content=7, +4 borders=11
    expect(d.getComputedHeight()).toBe(1 + 2 + 4 + 4);
  });

  it('uses default agentLogLines of 20', () => {
    const d = new Dashboard(5);
    // PhaseBar=1, lanes=0, agentLog=20 => content=21, +4 borders=25
    expect(d.getComputedHeight()).toBe(1 + 0 + 20 + 4);
  });

  // ── Sub-component getters ──────────────────────────────────────────
  it('exposes phaseBar, lanePool, and agentLog via getters', () => {
    const d = new Dashboard(2, 3);
    expect(d.phaseBar).toBeDefined();
    expect(d.lanePool).toBeDefined();
    expect(d.agentLog).toBeDefined();
  });

  // ── render line count ──────────────────────────────────────────────
  it('render() returns correct total line count with borders', () => {
    const d = new Dashboard(3, 4);
    const lines = d.render(WIDTH);
    // PhaseBar=1, lanes=0 (no lanes set), agentLog=4 => content=5, +4 borders=9
    expect(lines).toHaveLength(1 + 0 + 4 + 4);
  });

  it('render() with lanes returns correct line count', () => {
    const d = new Dashboard(3, 4);
    d.lanePool.updateLanes([
      { id: 't1', title: 'A', status: 'ready' },
      { id: 't2', title: 'B', status: 'done' },
    ]);
    const lines = d.render(WIDTH);
    // PhaseBar=1, lanes=2, agentLog=4 => content=7, +4 borders=11
    expect(lines).toHaveLength(1 + 2 + 4 + 4);
  });

  it('render() with default agentLogLines returns correct line count', () => {
    const d = new Dashboard(2);
    const lines = d.render(WIDTH);
    // PhaseBar=1, lanes=0, agentLog=20 => content=21, +4 borders=25
    expect(lines).toHaveLength(1 + 0 + 20 + 4);
  });

  // ── render() border structure ──────────────────────────────────────
  it('render() starts with top border ┌─┐', () => {
    const d = new Dashboard(2, 3);
    const lines = d.render(WIDTH);
    expect(lines[0]).toBe('┌' + '─'.repeat(WIDTH - 2) + '┐');
  });

  it('render() ends with bottom border └─┘', () => {
    const d = new Dashboard(2, 3);
    const lines = d.render(WIDTH);
    expect(lines[lines.length - 1]).toBe('└' + '─'.repeat(WIDTH - 2) + '┘');
  });

  it('render() has separators ├─┤ between sections', () => {
    const d = new Dashboard(2, 3);
    const lines = d.render(WIDTH);
    const sep = '├' + '─'.repeat(WIDTH - 2) + '┤';
    // Separator positions: after phaseBar (index 1), after lanePool content
    // With 0 lanes: lines = [top, phaseContent, sep, sep, agentLog..., bottom]
    // line[0]=top, line[1]=phase, line[2]=sep(phase/lanes), line[3]=sep(lanes/log) ... wait
    // PhaseBar=1, lanes=0 => after phaseBar separator, then immediately lanes separator (0 lanes),
    // then agentLog content, then bottom
    // Structure: top(0), phase(1), sep(2), sep(3), log(4-6), bottom(7)
    const sepCount = lines.filter((l) => l === sep).length;
    expect(sepCount).toBe(2);
  });

  it('render() wraps content lines with │', () => {
    const d = new Dashboard(2, 3);
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
    const d = new Dashboard(2, 3);

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
  it('handleInput delegates to lanePool for non-arrow keys', () => {
    const d = new Dashboard(3, 4);
    d.lanePool.updateLanes([
      { id: 't1', title: 'A', status: 'ready' },
      { id: 't2', title: 'B', status: 'ready' },
      { id: 't3', title: 'C', status: 'ready' },
    ]);
    d.lanePool.setFocusedLaneById('t1');

    expect(d.lanePool.getFocusedTaskId()).toBe('t1');

    d.handleInput('\x1b[B'); // Down arrow
    expect(d.lanePool.getFocusedTaskId()).toBe('t2');
  });

  it('handleInput routes left/right arrows to agentLog', () => {
    const d = new Dashboard(3, 4);
    // Set up two agents so navigation works
    d.agentLog.selectAgent('agent-1', 'coder');
    d.agentLog.selectAgent('agent-2', 'scout');
    // Current agent is agent-2
    expect(d.agentLog.getCurrentAgentId()).toBe('agent-2');

    d.handleInput('\x1b[D'); // Left arrow
    expect(d.agentLog.getCurrentAgentId()).toBe('agent-1');

    d.handleInput('\x1b[C'); // Right arrow
    expect(d.agentLog.getCurrentAgentId()).toBe('agent-2');
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
    const d = new Dashboard(2, 3);
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
    const d = new Dashboard(2, 4);
    d.agentLog.selectAgent('agent-1', 'coder');
    d.agentLog.addEntry({ type: 'error', content: 'something failed' });

    const lines = d.render(WIDTH);

    // Agent log content starts after: top(1) + phase(1) + sep(1) + sep(1)
    // = index 4.  The first entry with ⚠️ is at index 4.
    const entryLine = lines[4];
    expect(entryLine.startsWith('│')).toBe(true);
    expect(entryLine.endsWith('│')).toBe(true);
    expect(visibleWidth(entryLine)).toBe(WIDTH);
  });

  it('LanePool content lines have correct visible width when colored', () => {
    const d = new Dashboard(3, 2);
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
    const d = new Dashboard(2, 3);
    d.phaseBar.setPhases([
      { id: 'plan', label: 'Plan', icon: '📋' },
      { id: 'build', label: 'Build', icon: '🔨' },
    ]);
    d.phaseBar.setCurrentPhase('plan');
    d.agentLog.selectAgent('a1', 'coder');
    d.agentLog.addEntry({ type: 'text', content: 'hi' });

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
    const d = new Dashboard(2, 3);
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
    const d = new Dashboard(4, 2);
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
    const d = new Dashboard(2, 5);
    d.agentLog.selectAgent('a1', 'coder');
    d.agentLog.addEntry({ type: 'text', content: 'hello' });
    d.agentLog.addEntry({ type: 'thinking', content: 'thinking...' });
    d.agentLog.addEntry({ type: 'error', content: 'oops' });
    d.agentLog.addEntry({ type: 'tool_call_start', content: 'running tool' });

    const lines = d.render(WIDTH);

    // All agent log lines (header + entries + empty) should have correct visible width
    for (let i = 4; i < lines.length; i++) {
      if (lines[i].startsWith('│')) {
        expect(visibleWidth(lines[i])).toBe(WIDTH);
      }
    }
  });
});
