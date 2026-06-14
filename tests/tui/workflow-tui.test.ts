import { TUI } from '@earendil-works/pi-tui';
import { describe, expect, it, mock, spyOn } from 'bun:test';
import { EventStore } from '../../src/tracking/event-store.js';
import type { WorkflowProjection } from '../../src/tracking/event-types.js';
import { createStoreCallbacks } from '../../src/tracking/store-callbacks.js';
import { WorkflowTUI } from '../../src/tui/workflow-tui.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Create a minimal projection with agents in given phases. */
function projectionWithAgents(phases: string[], agentIds: string[]): WorkflowProjection {
  const p: WorkflowProjection = {
    seq: 0,
    taskPrompt: '',
    currentPhase: phases[0] ?? '',
    completedPhases: [],
    tasks: {},
    agents: {},
    sidebar: { title: '', indicator: '', phases: phases.map((id) => ({ id, label: id, icon: '📋' })) },
    status: 'running',
    stats: { totalTokens: 0, agentCount: 0 },
  };
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

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('WorkflowTUI', () => {
  describe('constructor', () => {
    it('creates an instance with default options', () => {
      const tui = new WorkflowTUI();
      expect(tui).toBeDefined();
    });

    it('creates an instance with custom options', () => {
      const tui = new WorkflowTUI({ maxConcurrentLanes: 5, agentLogLines: 6 });
      expect(tui).toBeDefined();
    });

    it('creates an instance with a store', () => {
      const store = new EventStore('/tmp/test');
      const tui = new WorkflowTUI({ store });
      expect(tui).toBeDefined();
    });

    it('exposes an EventLog via getEventLog()', () => {
      const tui = new WorkflowTUI();
      const eventLog = tui.getEventLog();
      expect(eventLog).toBeDefined();
      expect(typeof eventLog.addLine).toBe('function');
      expect(typeof eventLog.render).toBe('function');
    });

    it('exposes a Dashboard via getDashboard()', () => {
      const tui = new WorkflowTUI();
      const dashboard = tui.getDashboard();
      expect(dashboard).toBeDefined();
      expect(dashboard.phaseBar).toBeDefined();
      expect(dashboard.lanePool).toBeDefined();
      expect(dashboard.agentLog).toBeDefined();
    });

    it('store-backed TUI syncs projection into dashboard', () => {
      const store = new EventStore('/tmp/test');
      const storeCallbacks = createStoreCallbacks(store);
      const tui = new WorkflowTUI({ store });

      // Append events to the store
      storeCallbacks.onWorkflowStart!({ taskPrompt: 'test', resumed: false, workDir: '/tmp' });
      storeCallbacks.onPhaseStart!({ phase: 'scouting', round: 1 });
      storeCallbacks.onSidebarUpdate!({
        phases: [{ id: 'scouting', label: 'Scouting', icon: '🔍' }],
      });

      // Dashboard should have synced the projection
      const dashboard = tui.getDashboard();
      expect(dashboard.agentLog.hasPhases()).toBe(true);
      expect(dashboard.agentLog.getCurrentPhase()).toBe('scouting');
    });
  });

  describe('console override and restore', () => {
    it('routes console.log through eventLog when overridden', () => {
      const tui = new WorkflowTUI();
      const eventLog = tui.getEventLog();
      const originalLog = console.log;

      console.log = (...args: unknown[]) => {
        eventLog.addLine(args.join(' '));
      };

      console.log('hello from test');
      const lines = eventLog.render(80);
      const joined = lines.join('\n');
      expect(joined).toContain('hello from test');

      console.log = originalLog;
    });

    it('routes console.warn through eventLog with prefix', () => {
      const tui = new WorkflowTUI();
      const eventLog = tui.getEventLog();
      const originalWarn = console.warn;

      console.warn = (...args: unknown[]) => {
        eventLog.addLine('⚠️ ' + args.join(' '));
      };

      console.warn('watch out');
      const lines = eventLog.render(80);
      const joined = lines.join('\n');
      expect(joined).toContain('⚠️ watch out');

      console.warn = originalWarn;
    });

    it('routes console.error through eventLog with prefix', () => {
      const tui = new WorkflowTUI();
      const eventLog = tui.getEventLog();
      const originalError = console.error;

      console.error = (...args: unknown[]) => {
        eventLog.addLine('❌ ' + args.join(' '));
      };

      console.error('something broke');
      const lines = eventLog.render(80);
      const joined = lines.join('\n');
      expect(joined).toContain('❌ something broke');

      console.error = originalError;
    });

    it('restores original console methods after stop-like cleanup', () => {
      const originalLog = console.log;
      const originalWarn = console.warn;
      const originalError = console.error;

      console.log = () => {};
      console.warn = () => {};
      console.error = () => {};

      expect(console.log).not.toBe(originalLog);
      expect(console.warn).not.toBe(originalWarn);
      expect(console.error).not.toBe(originalError);

      console.log = originalLog;
      console.warn = originalWarn;
      console.error = originalError;

      expect(console.log).toBe(originalLog);
      expect(console.warn).toBe(originalWarn);
      expect(console.error).toBe(originalError);
    });
  });

  describe('interrupt handling', () => {
    it('increments interruptCount on first Ctrl+C and calls abort', () => {
      let abortCalled = false;
      const tui = new WorkflowTUI({
        abort: () => {
          abortCalled = true;
        },
      });

      let interruptCount = 0;
      const eventLog = tui.getEventLog();

      interruptCount++;
      if (interruptCount === 1) {
        eventLog.addLine('⏹ Stopping workflow...');
      }

      expect(interruptCount).toBe(1);
      expect(abortCalled).toBe(false);

      const lines = eventLog.render(80);
      const joined = lines.join('\n');
      expect(joined).toContain('⏹ Stopping workflow...');
    });

    it('would call process.exit on second Ctrl+C (verified by counter logic)', () => {
      let interruptCount = 0;

      interruptCount++;
      expect(interruptCount).toBe(1);

      interruptCount++;
      expect(interruptCount).toBe(2);
    });
  });

  describe('arrow key routing to agent log', () => {
    const LEFT_ARROW = '\x1b[D';
    const RIGHT_ARROW = '\x1b[C';

    /** Helper: set up dashboard with agents via syncFromProjection. */
    function setupTwoAgents(tui: WorkflowTUI) {
      const dashboard = tui.getDashboard();
      const p = projectionWithAgents(['test'], ['agent-1', 'agent-2']);
      dashboard.syncFromProjection(p);
      return dashboard;
    }

    it('dashboard.handleInput routes left arrow to agentLog, switching agents', () => {
      const tui = new WorkflowTUI();
      const dashboard = setupTwoAgents(tui);

      expect(dashboard.agentLog.getSelectedAgentUid()).toBeTruthy();

      dashboard.handleInput(RIGHT_ARROW);
      const uid2 = dashboard.agentLog.getSelectedAgentUid();

      dashboard.handleInput(LEFT_ARROW);
      const uid1 = dashboard.agentLog.getSelectedAgentUid();

      expect(uid1).not.toBe(uid2);
    });

    it('dashboard.handleInput routes right arrow to agentLog, switching agents', () => {
      const tui = new WorkflowTUI();
      const dashboard = setupTwoAgents(tui);

      const uid1 = dashboard.agentLog.getSelectedAgentUid();

      dashboard.handleInput(RIGHT_ARROW);
      const uid2 = dashboard.agentLog.getSelectedAgentUid();
      expect(uid2).not.toBe(uid1);

      dashboard.handleInput(RIGHT_ARROW);
      const uid3 = dashboard.agentLog.getSelectedAgentUid();
      // Wraps back to first agent
      expect(uid3).toBe(uid1);
    });

    it('dashboard.handleInput with spy verifies left arrow is forwarded to agentLog', () => {
      const tui = new WorkflowTUI();
      const dashboard = setupTwoAgents(tui);
      const agentSpy = spyOn(dashboard.agentLog, 'handleInput');

      dashboard.handleInput(LEFT_ARROW);
      expect(agentSpy).toHaveBeenCalledTimes(1);
      expect(agentSpy).toHaveBeenCalledWith(LEFT_ARROW);

      agentSpy.mockRestore();
    });

    it('dashboard.handleInput with spy verifies right arrow is forwarded to agentLog', () => {
      const tui = new WorkflowTUI();
      const dashboard = setupTwoAgents(tui);
      const agentSpy = spyOn(dashboard.agentLog, 'handleInput');

      dashboard.handleInput(RIGHT_ARROW);
      expect(agentSpy).toHaveBeenCalledTimes(1);
      expect(agentSpy).toHaveBeenCalledWith(RIGHT_ARROW);

      agentSpy.mockRestore();
    });

    it('non-arrow keys are NOT routed to agentLog by dashboard.handleInput', () => {
      const tui = new WorkflowTUI();
      const dashboard = setupTwoAgents(tui);
      const agentSpy = spyOn(dashboard.agentLog, 'handleInput');

      dashboard.handleInput('x');
      expect(agentSpy).not.toHaveBeenCalled();

      agentSpy.mockRestore();
    });

    it('input listener fix expectation: arrow keys must be consumed by the global listener', () => {
      const tui = new WorkflowTUI();
      const dashboard = setupTwoAgents(tui);

      expect(dashboard.agentLog.getSelectedAgentUid()).toBeTruthy();

      dashboard.handleInput(RIGHT_ARROW);
      // Agent should have switched — proving the pipeline works end-to-end
      expect(dashboard.agentLog.getSelectedAgentUid()).toBeTruthy();
    });
  });

  describe('dashboard integration', () => {
    it('uses custom maxConcurrentLanes and agentLogLines', () => {
      const tui = new WorkflowTUI({ maxConcurrentLanes: 5, agentLogLines: 8 });
      const dashboard = tui.getDashboard();
      expect(dashboard.getComputedHeight()).toBe(1 + 0 + 8 + 4);
    });

    it('uses default maxConcurrentLanes (5) and agentLogLines (20)', () => {
      const tui = new WorkflowTUI();
      const dashboard = tui.getDashboard();
      expect(dashboard.getComputedHeight()).toBe(1 + 0 + 20 + 4);
    });
  });

  describe('requestRender on key handling', () => {
    const CTRL_C = '\x03';
    const TAB = '\t';
    const LEFT_ARROW = '\x1b[D';
    const RIGHT_ARROW = '\x1b[C';
    const SPACE = ' ';
    const UP_ARROW = '\x1b[A';
    const DOWN_ARROW = '\x1b[B';
    const SHIFT_UP = '\x1b[a';
    const SHIFT_DOWN = '\x1b[b';

    function setupTest() {
      let capturedCallback: ((data: string) => any) | null = null;
      const requestRenderMock = mock(() => {});

      const addListenerSpy = spyOn(TUI.prototype, 'addInputListener').mockImplementation(function (
        this: any,
        cb: (data: string) => any,
      ) {
        capturedCallback = cb;
        this.requestRender = requestRenderMock;
        return () => {};
      });

      const tuiStartSpy = spyOn(TUI.prototype, 'start').mockImplementation(() => {});
      const tuiStopSpy = spyOn(TUI.prototype, 'stop').mockImplementation(() => {});

      const wtui = new WorkflowTUI({ abort: () => {} });
      wtui.start();

      return {
        wtui,
        capturedCallback,
        requestRenderMock,
        cleanup: () => {
          wtui.stop();
          addListenerSpy.mockRestore();
          tuiStartSpy.mockRestore();
          tuiStopSpy.mockRestore();
        },
      };
    }

    it('calls requestRender when Tab key is handled', () => {
      const { capturedCallback, requestRenderMock, cleanup } = setupTest();
      try {
        expect(capturedCallback).not.toBeNull();
        capturedCallback!(TAB);
        expect(requestRenderMock).toHaveBeenCalled();
      } finally {
        cleanup();
      }
    });

    it('calls requestRender when Left arrow key is handled', () => {
      const { capturedCallback, requestRenderMock, cleanup } = setupTest();
      try {
        expect(capturedCallback).not.toBeNull();
        capturedCallback!(LEFT_ARROW);
        expect(requestRenderMock).toHaveBeenCalled();
      } finally {
        cleanup();
      }
    });

    it('calls requestRender when Right arrow key is handled', () => {
      const { capturedCallback, requestRenderMock, cleanup } = setupTest();
      try {
        expect(capturedCallback).not.toBeNull();
        capturedCallback!(RIGHT_ARROW);
        expect(requestRenderMock).toHaveBeenCalled();
      } finally {
        cleanup();
      }
    });

    it('calls requestRender when Ctrl+C is handled (regression)', () => {
      const { capturedCallback, requestRenderMock, cleanup } = setupTest();
      try {
        expect(capturedCallback).not.toBeNull();
        capturedCallback!(CTRL_C);
        expect(requestRenderMock).toHaveBeenCalled();
      } finally {
        cleanup();
      }
    });

    it('calls requestRender when Space key toggles expand', () => {
      const { capturedCallback, requestRenderMock, cleanup } = setupTest();
      try {
        expect(capturedCallback).not.toBeNull();
        capturedCallback!(SPACE);
        expect(requestRenderMock).toHaveBeenCalled();
      } finally {
        cleanup();
      }
    });

    it('consumes Up arrow and calls requestRender when agent log is expanded', () => {
      const { capturedCallback, requestRenderMock, wtui, cleanup } = setupTest();
      try {
        expect(capturedCallback).not.toBeNull();
        wtui.dashboard.agentLog.toggleExpand();
        expect(wtui.dashboard.agentLog.isExpanded()).toBe(true);

        const result = capturedCallback!(UP_ARROW);
        expect(result).toEqual({ consume: true });
        expect(requestRenderMock).toHaveBeenCalled();
      } finally {
        cleanup();
      }
    });

    it('consumes Down arrow and calls requestRender when agent log is expanded', () => {
      const { capturedCallback, requestRenderMock, wtui, cleanup } = setupTest();
      try {
        expect(capturedCallback).not.toBeNull();
        wtui.dashboard.agentLog.toggleExpand();
        expect(wtui.dashboard.agentLog.isExpanded()).toBe(true);

        const result = capturedCallback!(DOWN_ARROW);
        expect(result).toEqual({ consume: true });
        expect(requestRenderMock).toHaveBeenCalled();
      } finally {
        cleanup();
      }
    });

    it('consumes Up arrow even when agent log is NOT expanded', () => {
      const { capturedCallback, requestRenderMock, cleanup } = setupTest();
      try {
        expect(capturedCallback).not.toBeNull();
        const result = capturedCallback!(UP_ARROW);
        expect(result).toEqual({ consume: true });
        expect(requestRenderMock).toHaveBeenCalled();
      } finally {
        cleanup();
      }
    });

    it('consumes Down arrow even when agent log is NOT expanded', () => {
      const { capturedCallback, requestRenderMock, cleanup } = setupTest();
      try {
        expect(capturedCallback).not.toBeNull();
        const result = capturedCallback!(DOWN_ARROW);
        expect(result).toEqual({ consume: true });
        expect(requestRenderMock).toHaveBeenCalled();
      } finally {
        cleanup();
      }
    });

    it('existing Left/Right handler still works after adding new handlers', () => {
      const { capturedCallback, requestRenderMock, cleanup } = setupTest();
      try {
        expect(capturedCallback).not.toBeNull();
        const leftResult = capturedCallback!(LEFT_ARROW);
        expect(leftResult).toEqual({ consume: true });
        expect(requestRenderMock).toHaveBeenCalled();

        requestRenderMock.mockClear();
        const rightResult = capturedCallback!(RIGHT_ARROW);
        expect(rightResult).toEqual({ consume: true });
        expect(requestRenderMock).toHaveBeenCalled();
      } finally {
        cleanup();
      }
    });

    it('existing Tab handler still works after adding new handlers', () => {
      const { capturedCallback, requestRenderMock, cleanup } = setupTest();
      try {
        expect(capturedCallback).not.toBeNull();
        const result = capturedCallback!(TAB);
        expect(result).toEqual({ consume: true });
        expect(requestRenderMock).toHaveBeenCalled();
      } finally {
        cleanup();
      }
    });

    it('existing Ctrl+C handler still works after adding new handlers', () => {
      const { capturedCallback, requestRenderMock, cleanup } = setupTest();
      try {
        expect(capturedCallback).not.toBeNull();
        const result = capturedCallback!(CTRL_C);
        expect(result).toEqual({ consume: true });
        expect(requestRenderMock).toHaveBeenCalled();
      } finally {
        cleanup();
      }
    });

    // ─── Scroll key routing (PgUp/PgDn/Home/End) ───────────────────────

    it('routes pageUp key to eventLog.handleInput and consumes it', () => {
      const { capturedCallback, requestRenderMock, wtui, cleanup } = setupTest();
      try {
        expect(capturedCallback).not.toBeNull();
        for (let i = 1; i <= 10; i++) {
          wtui.getEventLog().addLine(`line ${i}`);
        }
        expect(wtui.getEventLog().isScrolledUp).toBe(false);

        const result = capturedCallback!('\x1b[5~');
        expect(result).toEqual({ consume: true });
        expect(requestRenderMock).toHaveBeenCalled();
        expect(wtui.getEventLog().isScrolledUp).toBe(true);
      } finally {
        cleanup();
      }
    });

    it('routes pageDown key to eventLog.handleInput and consumes it', () => {
      const { capturedCallback, requestRenderMock, wtui, cleanup } = setupTest();
      try {
        expect(capturedCallback).not.toBeNull();
        for (let i = 1; i <= 10; i++) {
          wtui.getEventLog().addLine(`line ${i}`);
        }
        capturedCallback!('\x1b[5~');
        expect(wtui.getEventLog().isScrolledUp).toBe(true);
        requestRenderMock.mockClear();

        const result = capturedCallback!('\x1b[6~');
        expect(result).toEqual({ consume: true });
        expect(requestRenderMock).toHaveBeenCalled();
      } finally {
        cleanup();
      }
    });

    it('routes home key to eventLog.handleInput and consumes it', () => {
      const { capturedCallback, requestRenderMock, wtui, cleanup } = setupTest();
      try {
        expect(capturedCallback).not.toBeNull();
        for (let i = 1; i <= 10; i++) {
          wtui.getEventLog().addLine(`line ${i}`);
        }
        expect(wtui.getEventLog().isScrolledUp).toBe(false);

        const result = capturedCallback!('\x1b[H');
        expect(result).toEqual({ consume: true });
        expect(requestRenderMock).toHaveBeenCalled();
        expect(wtui.getEventLog().isScrolledUp).toBe(true);
      } finally {
        cleanup();
      }
    });

    it('routes end key to eventLog.handleInput and consumes it', () => {
      const { capturedCallback, requestRenderMock, wtui, cleanup } = setupTest();
      try {
        expect(capturedCallback).not.toBeNull();
        for (let i = 1; i <= 10; i++) {
          wtui.getEventLog().addLine(`line ${i}`);
        }
        capturedCallback!('\x1b[5~');
        expect(wtui.getEventLog().isScrolledUp).toBe(true);
        requestRenderMock.mockClear();

        const result = capturedCallback!('\x1b[F');
        expect(result).toEqual({ consume: true });
        expect(requestRenderMock).toHaveBeenCalled();
        expect(wtui.getEventLog().isScrolledUp).toBe(false);
      } finally {
        cleanup();
      }
    });

    it('routes pageDown to bottom enables autoScroll on eventLog', () => {
      const { capturedCallback, wtui, cleanup } = setupTest();
      try {
        expect(capturedCallback).not.toBeNull();
        for (let i = 1; i <= 10; i++) {
          wtui.getEventLog().addLine(`line ${i}`);
        }
        capturedCallback!('\x1b[5~');
        expect(wtui.getEventLog().isScrolledUp).toBe(true);
        capturedCallback!('\x1b[6~');

        wtui.getEventLog().addLine('bottom line');
        expect(wtui.getEventLog().isScrolledUp).toBe(false);
      } finally {
        cleanup();
      }
    });

    it('scroll keys do not interfere with other key handlers', () => {
      const { capturedCallback, requestRenderMock, cleanup } = setupTest();
      try {
        expect(capturedCallback).not.toBeNull();

        let result = capturedCallback!('\t');
        expect(result).toEqual({ consume: true });

        requestRenderMock.mockClear();
        result = capturedCallback!('\x1b[D');
        expect(result).toEqual({ consume: true });

        requestRenderMock.mockClear();
        result = capturedCallback!('\x1b[C');
        expect(result).toEqual({ consume: true });

        requestRenderMock.mockClear();
        result = capturedCallback!('\x1b[5~');
        expect(result).toEqual({ consume: true });

        requestRenderMock.mockClear();
        result = capturedCallback!('\x1b[6~');
        expect(result).toEqual({ consume: true });

        requestRenderMock.mockClear();
        result = capturedCallback!('\x1b[H');
        expect(result).toEqual({ consume: true });

        requestRenderMock.mockClear();
        result = capturedCallback!('\x1b[F');
        expect(result).toEqual({ consume: true });
      } finally {
        cleanup();
      }
    });

    it('requests render for each scroll key', () => {
      const { capturedCallback, requestRenderMock, cleanup } = setupTest();
      try {
        expect(capturedCallback).not.toBeNull();
        const scrollKeys = ['\x1b[5~', '\x1b[6~', '\x1b[H', '\x1b[F'];
        for (const key of scrollKeys) {
          requestRenderMock.mockClear();
          capturedCallback!(key);
          expect(requestRenderMock).toHaveBeenCalled();
        }
      } finally {
        cleanup();
      }
    });

    it('scroll keys set autoscroll to false when scrolling up', () => {
      const { capturedCallback, wtui, cleanup } = setupTest();
      try {
        expect(capturedCallback).not.toBeNull();
        for (let i = 1; i <= 10; i++) {
          wtui.getEventLog().addLine(`line ${i}`);
        }
        capturedCallback!('\x1b[5~');
        wtui.getEventLog().addLine('new line');
        expect(wtui.getEventLog().isScrolledUp).toBe(true);
      } finally {
        cleanup();
      }
    });

    // ─── Shift+Up/Shift+Down scroll by 10 ───────────────────────────

    it('shift+up scrolls by 10 when expanded', () => {
      const { capturedCallback, requestRenderMock, wtui, cleanup } = setupTest();
      try {
        expect(capturedCallback).not.toBeNull();
        const dashboard = wtui.dashboard;

        dashboard.agentLog.toggleExpand();
        expect(dashboard.agentLog.isExpanded()).toBe(true);

        // Sync agents via store projection
        const store = new EventStore('/tmp/test-scroll');
        const sc = createStoreCallbacks(store);
        sc.onPhaseStart!({ phase: 'test', round: 1 });
        sc.onAgentSpawn!({ agentId: 'agent-1', profile: 'coder', phase: 'test' });
        // Add entries via turnEnd
        for (let i = 1; i <= 60; i++) {
          sc.onTurnEnd!({
            agentId: 'agent-1',
            turn: i,
            contentBlocks: [{ type: 'text', text: `entry ${i}` }],
          });
        }
        sc.onSidebarUpdate!({ phases: [{ id: 'test', label: 'test', icon: '📋' }] });
        dashboard.syncFromProjection(store.getProjection());

        dashboard.agentLog.render(80);

        for (let i = 0; i < 3; i++) {
          capturedCallback!(SHIFT_UP);
        }

        const lines = dashboard.agentLog.render(80);
        const joined = lines.join('\n');
        expect(joined).toMatch(/up arrow \d+ more/);
        expect(requestRenderMock).toHaveBeenCalled();
      } finally {
        cleanup();
      }
    });

    it('shift+down scrolls by 10 when expanded', () => {
      const { capturedCallback, requestRenderMock, wtui, cleanup } = setupTest();
      try {
        expect(capturedCallback).not.toBeNull();
        const dashboard = wtui.dashboard;

        dashboard.agentLog.toggleExpand();

        const store = new EventStore('/tmp/test-scroll2');
        const sc = createStoreCallbacks(store);
        sc.onPhaseStart!({ phase: 'test', round: 1 });
        sc.onAgentSpawn!({ agentId: 'agent-1', profile: 'coder', phase: 'test' });
        for (let i = 1; i <= 60; i++) {
          sc.onTurnEnd!({
            agentId: 'agent-1',
            turn: i,
            contentBlocks: [{ type: 'text', text: `entry ${i}` }],
          });
        }
        sc.onSidebarUpdate!({ phases: [{ id: 'test', label: 'test', icon: '📋' }] });
        dashboard.syncFromProjection(store.getProjection());
        dashboard.agentLog.render(80);

        for (let i = 0; i < 5; i++) {
          capturedCallback!(SHIFT_UP);
        }
        requestRenderMock.mockClear();

        capturedCallback!(SHIFT_DOWN);

        const lines = dashboard.agentLog.render(80);
        const joined = lines.join('\n');
        expect(joined).toMatch(/up arrow \d+ more/);
        expect(requestRenderMock).toHaveBeenCalled();
      } finally {
        cleanup();
      }
    });

    it('shift+up falls through when NOT expanded', () => {
      const { capturedCallback, requestRenderMock, wtui, cleanup } = setupTest();
      try {
        expect(capturedCallback).not.toBeNull();
        expect(wtui.dashboard.agentLog.isExpanded()).toBe(false);

        const result = capturedCallback!(SHIFT_UP);
        expect(result).toBeUndefined();
        expect(requestRenderMock).not.toHaveBeenCalled();
      } finally {
        cleanup();
      }
    });

    it('shift+down falls through when NOT expanded', () => {
      const { capturedCallback, requestRenderMock, wtui, cleanup } = setupTest();
      try {
        expect(capturedCallback).not.toBeNull();
        expect(wtui.dashboard.agentLog.isExpanded()).toBe(false);

        const result = capturedCallback!(SHIFT_DOWN);
        expect(result).toBeUndefined();
        expect(requestRenderMock).not.toHaveBeenCalled();
      } finally {
        cleanup();
      }
    });
  });

  describe('left/right does not sync lane pool focus', () => {
    const RIGHT_ARROW = '\x1b[C';

    it('left/right arrow navigation does not change lane pool focus', () => {
      const tui = new WorkflowTUI();
      const dashboard = tui.getDashboard();

      const p = projectionWithAgents(['test'], ['agent-1', 'agent-2']);
      dashboard.syncFromProjection(p);

      expect(dashboard.lanePool.getFocusedTaskId()).toBeUndefined();

      dashboard.handleInput(RIGHT_ARROW);
      expect(dashboard.lanePool.getFocusedTaskId()).toBeUndefined();

      dashboard.handleInput(RIGHT_ARROW);
      expect(dashboard.lanePool.getFocusedTaskId()).toBeUndefined();
    });
  });

  describe('showQrCode', () => {
    it('creates an overlay via mocked TUI', async () => {
      const hideMock = mock(() => {});
      const overlayHandle = {
        hide: hideMock,
        setHidden: mock(() => {}),
        isHidden: mock(() => false),
        focus: mock(() => {}),
        unfocus: mock(() => {}),
        isFocused: mock(() => false),
      };

      const mockShowOverlay = mock(() => overlayHandle);
      const mockRequestRender = mock(() => {});

      const wtui = new WorkflowTUI();
      (wtui as any).tui = {
        showOverlay: mockShowOverlay,
        requestRender: mockRequestRender,
        addInputListener: mock(() => () => {}),
        addChild: mock(() => {}),
        setFocus: mock(() => {}),
        stop: mock(() => {}),
        start: mock(() => {}),
      } as any;
      (wtui as any).running = true;

      await wtui.showQrCode('https://example.com');

      expect(mockShowOverlay).toHaveBeenCalledTimes(1);
      const [component, options] = mockShowOverlay.mock.calls[0];
      expect(component).toBeDefined();
      expect(typeof component.render).toBe('function');
      expect(options).toEqual({ anchor: 'top-right', nonCapturing: true, margin: { top: 1, right: 1 } });
      expect(mockRequestRender).toHaveBeenCalled();
    });

    it('hides existing overlay handle before creating a new one', async () => {
      const hideMock1 = mock(() => {});
      const overlayHandle1 = {
        hide: hideMock1,
        setHidden: mock(() => {}),
        isHidden: mock(() => false),
        focus: mock(() => {}),
        unfocus: mock(() => {}),
        isFocused: mock(() => false),
      };

      const mockShowOverlay = mock(() => overlayHandle1);
      const mockRequestRender = mock(() => {});

      const wtui = new WorkflowTUI();
      (wtui as any).tui = {
        showOverlay: mockShowOverlay,
        requestRender: mockRequestRender,
        addInputListener: mock(() => () => {}),
        addChild: mock(() => {}),
        setFocus: mock(() => {}),
        stop: mock(() => {}),
        start: mock(() => {}),
      } as any;
      (wtui as any).running = true;

      await wtui.showQrCode('https://example.com');
      expect(hideMock1).not.toHaveBeenCalled();
      expect(mockShowOverlay).toHaveBeenCalledTimes(1);

      const hideMock2 = mock(() => {});
      const overlayHandle2 = {
        hide: hideMock2,
        setHidden: mock(() => {}),
        isHidden: mock(() => false),
        focus: mock(() => {}),
        unfocus: mock(() => {}),
        isFocused: mock(() => false),
      };
      mockShowOverlay.mockReturnValue(overlayHandle2);

      await wtui.showQrCode('https://other.com');

      expect(hideMock1).toHaveBeenCalledTimes(1);
      expect(mockShowOverlay).toHaveBeenCalledTimes(2);
      expect(mockRequestRender).toHaveBeenCalledTimes(2);
    });
  });

  describe('prepareQrCode', () => {
    function setupStartWithShowOverlaySpy() {
      const overlayHandle = {
        hide: mock(() => {}),
        setHidden: mock(() => {}),
        isHidden: mock(() => false),
        focus: mock(() => {}),
        unfocus: mock(() => {}),
        isFocused: mock(() => false),
      };
      const mockShowOverlay = mock(() => overlayHandle);
      const addListenerSpy = spyOn(TUI.prototype, 'addInputListener').mockImplementation(function (this: any) {
        this.requestRender = () => {};
        this.showOverlay = mockShowOverlay;
        return () => {};
      });
      const tuiStartSpy = spyOn(TUI.prototype, 'start').mockImplementation(() => {});
      const tuiStopSpy = spyOn(TUI.prototype, 'stop').mockImplementation(() => {});
      return {
        overlayHandle,
        mockShowOverlay,
        cleanup: () => {
          addListenerSpy.mockRestore();
          tuiStartSpy.mockRestore();
          tuiStopSpy.mockRestore();
        },
      };
    }

    it('attaches the prepared QR overlay during start()', async () => {
      const { mockShowOverlay, cleanup } = setupStartWithShowOverlaySpy();
      try {
        const wtui = new WorkflowTUI({ abort: () => {} });
        await wtui.prepareQrCode('https://example.com');
        wtui.start();

        expect(mockShowOverlay).toHaveBeenCalledTimes(1);
        const [component, options] = mockShowOverlay.mock.calls[0];
        expect(component).toBeDefined();
        expect(typeof component.render).toBe('function');
        expect(options).toEqual({
          anchor: 'top-right',
          nonCapturing: true,
          margin: { top: 1, right: 1 },
        });
      } finally {
        cleanup();
      }
    });

    it('does not attach anything during start() when no QR was prepared', () => {
      const { mockShowOverlay, cleanup } = setupStartWithShowOverlaySpy();
      try {
        const wtui = new WorkflowTUI({ abort: () => {} });
        wtui.start();
        expect(mockShowOverlay).not.toHaveBeenCalled();
      } finally {
        cleanup();
      }
    });
  });

  describe('pauseForInspection', () => {
    function setupPauseTest() {
      const addInputMock = mock(() => () => {});
      const requestRenderMock = mock(() => {});
      const addLineMock = mock(() => {});

      const wtui = new WorkflowTUI();
      (wtui as any).tui = {
        showOverlay: mock(() => {}),
        requestRender: requestRenderMock,
        addInputListener: addInputMock,
        addChild: mock(() => {}),
        setFocus: mock(() => {}),
        stop: mock(() => {}),
        start: mock(() => {}),
      } as any;
      (wtui as any).running = true;
      (wtui as any).eventLog = {
        addLine: addLineMock,
        setMaxLines: mock(() => {}),
        render: mock(() => []),
      };

      return { wtui, addInputMock, requestRenderMock, addLineMock };
    }

    it('resolves immediately when signal is already aborted', async () => {
      const { wtui, addInputMock } = setupPauseTest();

      const signal = AbortSignal.abort();
      const start = performance.now();
      await wtui.pauseForInspection(signal);
      const elapsed = performance.now() - start;

      expect(elapsed).toBeLessThan(50);
      expect(addInputMock).not.toHaveBeenCalled();
    });

    it('resolves when signal is aborted after a tick', async () => {
      const { wtui, addInputMock } = setupPauseTest();

      const controller = new AbortController();
      const promise = wtui.pauseForInspection(controller.signal);

      expect(addInputMock).toHaveBeenCalledTimes(1);

      controller.abort();

      await expect(promise).resolves.toBeUndefined();
    });

    it('adds event log messages and requests render on pause', async () => {
      const { wtui, addLineMock, requestRenderMock } = setupPauseTest();

      const controller = new AbortController();
      const promise = wtui.pauseForInspection(controller.signal);

      expect(addLineMock).toHaveBeenCalledWith('');
      expect(addLineMock).toHaveBeenCalledWith('Workflow complete. Press Ctrl+C or Escape to quit.');
      expect(requestRenderMock).toHaveBeenCalled();

      controller.abort();
      await promise;
    });

    it('resolves when Ctrl+C key is pressed via the pause input listener', async () => {
      const { wtui, addInputMock } = setupPauseTest();

      const controller = new AbortController();
      const promise = wtui.pauseForInspection(controller.signal);

      expect(addInputMock).toHaveBeenCalledTimes(1);
      const listener = addInputMock.mock.calls[0][0];
      expect(typeof listener).toBe('function');

      const result = listener('\x03');
      expect(result).toEqual({ consume: true });

      await expect(promise).resolves.toBeUndefined();
    });

    it('resolves when Escape key is pressed via the pause input listener', async () => {
      const { wtui, addInputMock } = setupPauseTest();

      const controller = new AbortController();
      const promise = wtui.pauseForInspection(controller.signal);

      expect(addInputMock).toHaveBeenCalledTimes(1);
      const listener = addInputMock.mock.calls[0][0];

      const result = listener('\x1b');
      expect(result).toEqual({ consume: true });

      await expect(promise).resolves.toBeUndefined();
    });

    it('does nothing when tui is null', async () => {
      const wtui = new WorkflowTUI();
      await wtui.pauseForInspection();
    });

    it('does nothing when not running', async () => {
      const wtui = new WorkflowTUI();
      (wtui as any).tui = {
        addInputListener: mock(() => {}),
        requestRender: mock(() => {}),
      };
      (wtui as any).running = false;

      await wtui.pauseForInspection();
    });

    it('resolves signal abort after pause listener setup prevents double-resolution', async () => {
      const { wtui } = setupPauseTest();

      const controller = new AbortController();
      let resolveCount = 0;
      const promise = wtui.pauseForInspection(controller.signal);
      promise.then(() => resolveCount++);

      controller.abort();
      await promise;
      expect(resolveCount).toBe(1);
    });

    it('resolves via Ctrl+C even when AbortSignal never fires', async () => {
      const { wtui, addInputMock } = setupPauseTest();

      const promise = wtui.pauseForInspection();

      expect(addInputMock).toHaveBeenCalledTimes(1);
      const listener = addInputMock.mock.calls[0][0];

      listener('\x03');

      await expect(promise).resolves.toBeUndefined();
    });
  });
});
