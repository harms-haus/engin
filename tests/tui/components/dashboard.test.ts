import { describe, expect, it, spyOn } from 'bun:test';
import { Dashboard } from '../../../src/tui/components/dashboard.js';

const WIDTH = 80;

describe('Dashboard', () => {
  // ── getComputedHeight ───────────────────────────────────────────────
  it('returns correct total height (1 + maxConcurrentLanes + agentLogLines)', () => {
    const d = new Dashboard(3, 4);
    expect(d.getComputedHeight()).toBe(1 + 3 + 4);
  });

  it('uses default agentLogLines of 4', () => {
    const d = new Dashboard(5);
    expect(d.getComputedHeight()).toBe(1 + 5 + 4);
  });

  // ── Sub-component getters ──────────────────────────────────────────
  it('exposes phaseBar, lanePool, and agentLog via getters', () => {
    const d = new Dashboard(2, 3);
    expect(d.phaseBar).toBeDefined();
    expect(d.lanePool).toBeDefined();
    expect(d.agentLog).toBeDefined();
  });

  // ── render line count ──────────────────────────────────────────────
  it('render() returns correct total line count', () => {
    const d = new Dashboard(3, 4);
    const lines = d.render(WIDTH);
    expect(lines).toHaveLength(d.getComputedHeight());
  });

  it('render() with default agentLogLines returns correct line count', () => {
    const d = new Dashboard(2);
    const lines = d.render(WIDTH);
    expect(lines).toHaveLength(1 + 2 + 4);
  });

  // ── render() concatenation ─────────────────────────────────────────
  it('render() output matches concatenation of sub-component renders', () => {
    const d = new Dashboard(2, 3);

    // Configure sub-components with some state
    d.phaseBar.setPhases([{ id: 'plan', label: 'Plan', icon: '📋' }]);
    d.phaseBar.setCurrentPhase('plan');
    d.lanePool.updateLanes([
      { id: 't1', title: 'Task A', status: 'ready' },
      { id: 't2', title: 'Task B', status: 'done' },
    ]);
    d.agentLog.selectAgent('agent-1', 'coder');

    const phaseLines = d.phaseBar.render(WIDTH);
    const laneLines = d.lanePool.render(WIDTH);
    const logLines = d.agentLog.render(WIDTH);

    const expected = [...phaseLines, ...laneLines, ...logLines];
    const actual = d.render(WIDTH);

    expect(actual).toEqual(expected);
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
  it('handleInput delegates to lanePool', () => {
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
});
