import { describe, expect, it, spyOn } from 'bun:test';
import { Dashboard } from '../../../src/tui/components/dashboard.js';

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

  it('uses default agentLogLines of 10', () => {
    const d = new Dashboard(5);
    // PhaseBar=1, lanes=0, agentLog=10 => content=11, +4 borders=15
    expect(d.getComputedHeight()).toBe(1 + 0 + 10 + 4);
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
    // PhaseBar=1, lanes=0, agentLog=10 => content=11, +4 borders=15
    expect(lines).toHaveLength(1 + 0 + 10 + 4);
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
    expect(lines[1].length).toBe(WIDTH);
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
    d.lanePool.setFocusedLane(0);

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
