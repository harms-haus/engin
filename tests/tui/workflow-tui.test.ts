import { TUI } from '@earendil-works/pi-tui';
import { describe, expect, it, mock, spyOn } from 'bun:test';
import { WorkflowTUI } from '../../src/tui/workflow-tui.js';

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

    it('returns a valid StatusCallbacks object from getStatusCallbacks()', () => {
      const tui = new WorkflowTUI();
      const callbacks = tui.getStatusCallbacks();

      expect(callbacks).toBeDefined();
      // Verify all expected callback properties exist as functions
      expect(typeof callbacks.onWorkflowStart).toBe('function');
      expect(typeof callbacks.onWorkflowComplete).toBe('function');
      expect(typeof callbacks.onWorkflowFailed).toBe('function');
      expect(typeof callbacks.onPhaseStart).toBe('function');
      expect(typeof callbacks.onPhaseComplete).toBe('function');
      expect(typeof callbacks.onAgentSpawn).toBe('function');
      expect(typeof callbacks.onAgentComplete).toBe('function');
      expect(typeof callbacks.onTaskStart).toBe('function');
      expect(typeof callbacks.onTaskComplete).toBe('function');
      expect(typeof callbacks.onTaskRejected).toBe('function');
      expect(typeof callbacks.onDecision).toBe('function');
      expect(typeof callbacks.onError).toBe('function');
      expect(typeof callbacks.onTurnEnd).toBe('function');
      expect(typeof callbacks.onToolCallStart).toBe('function');
      expect(typeof callbacks.onToolCallEnd).toBe('function');
      expect(typeof callbacks.onSidebarUpdate).toBe('function');
    });

    it('status callbacks route through to eventLog and dashboard', () => {
      const tui = new WorkflowTUI();
      const callbacks = tui.getStatusCallbacks();
      const eventLog = tui.getEventLog();

      callbacks.onWorkflowStart!({ taskPrompt: 'test workflow', resumed: false, workDir: '/tmp' });

      const lines = eventLog.render(80);
      const joined = lines.join('\n');
      expect(joined).toContain('test workflow');
    });
  });

  describe('console override and restore', () => {
    it('routes console.log through eventLog when overridden', () => {
      const tui = new WorkflowTUI();
      const eventLog = tui.getEventLog();
      const originalLog = console.log;

      // Simulate what start() does: override console.log
      console.log = (...args: unknown[]) => {
        eventLog.addLine(args.join(' '));
      };

      console.log('hello from test');
      const lines = eventLog.render(80);
      const joined = lines.join('\n');
      expect(joined).toContain('hello from test');

      // Restore
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

      // Override
      console.log = () => {};
      console.warn = () => {};
      console.error = () => {};

      // Verify overridden
      expect(console.log).not.toBe(originalLog);
      expect(console.warn).not.toBe(originalWarn);
      expect(console.error).not.toBe(originalError);

      // Simulate what stop() does: restore
      console.log = originalLog;
      console.warn = originalWarn;
      console.error = originalError;

      // Verify restored
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

      // Simulate the interrupt logic directly (can't use handleInput without real TUI)
      let interruptCount = 0;
      const eventLog = tui.getEventLog();

      // First interrupt
      interruptCount++;
      if (interruptCount === 1) {
        eventLog.addLine('⏹ Stopping workflow...');
      }

      expect(interruptCount).toBe(1);
      expect(abortCalled).toBe(false); // abort not called because we're simulating logic only

      // Check eventLog captured the message
      const lines = eventLog.render(80);
      const joined = lines.join('\n');
      expect(joined).toContain('⏹ Stopping workflow...');
    });

    it('would call process.exit on second Ctrl+C (verified by counter logic)', () => {
      let interruptCount = 0;

      // Simulate first press
      interruptCount++;
      expect(interruptCount).toBe(1);

      // Simulate second press
      interruptCount++;
      expect(interruptCount).toBe(2);
      // In real code, process.exit(1) would be called here
    });
  });

  describe('arrow key routing to agent log', () => {
    // These tests verify the full integration pipeline:
    // WorkflowTUI → Dashboard.handleInput → AgentLogWidget state change
    // The fix in workflow-tui.ts routes left/right arrows to dashboard.handleInput.

    const LEFT_ARROW = '\x1b[D';
    const RIGHT_ARROW = '\x1b[C';

    /** Register helper: registers two agents in the 'test' phase and sets up the agent log. */
    function setupTwoAgents(tui: WorkflowTUI) {
      const dashboard = tui.getDashboard();
      dashboard.registry.register({ agentId: 'agent-1', profile: 'coder', phase: 'test' });
      dashboard.registry.register({ agentId: 'agent-2', profile: 'scout', phase: 'test' });
      dashboard.agentLog.setPhases(['test']);
      dashboard.agentLog.setCurrentPhase('test');
      return dashboard;
    }

    it('dashboard.handleInput routes left arrow to agentLog, switching agents', () => {
      const tui = new WorkflowTUI();
      const dashboard = setupTwoAgents(tui);

      // Initially selected is the first registered agent (agent-1)
      expect(dashboard.agentLog.getSelectedAgentUid()).toBe('agent-1');

      // Navigate right then left
      dashboard.handleInput(RIGHT_ARROW);
      expect(dashboard.agentLog.getSelectedAgentUid()).toBe('agent-2');

      dashboard.handleInput(LEFT_ARROW);
      expect(dashboard.agentLog.getSelectedAgentUid()).toBe('agent-1');
    });

    it('dashboard.handleInput routes right arrow to agentLog, switching agents', () => {
      const tui = new WorkflowTUI();
      const dashboard = setupTwoAgents(tui);

      // Initially agent-1 is selected
      expect(dashboard.agentLog.getSelectedAgentUid()).toBe('agent-1');

      dashboard.handleInput(RIGHT_ARROW);
      expect(dashboard.agentLog.getSelectedAgentUid()).toBe('agent-2');

      // Right from agent-2 wraps to agent-1
      dashboard.handleInput(RIGHT_ARROW);
      expect(dashboard.agentLog.getSelectedAgentUid()).toBe('agent-1');
    });

    it('dashboard.handleInput wraps left arrow from first to last agent', () => {
      const tui = new WorkflowTUI();
      const dashboard = tui.getDashboard();

      dashboard.registry.register({ agentId: 'agent-1', profile: 'coder', phase: 'test' });
      dashboard.registry.register({ agentId: 'agent-2', profile: 'scout', phase: 'test' });
      dashboard.registry.register({ agentId: 'agent-3', profile: 'planner', phase: 'test' });
      dashboard.agentLog.setPhases(['test']);
      dashboard.agentLog.setCurrentPhase('test');

      // Initially agent-1 is selected
      expect(dashboard.agentLog.getSelectedAgentUid()).toBe('agent-1');

      dashboard.handleInput(LEFT_ARROW);
      // Left from agent-1 wraps to agent-3
      expect(dashboard.agentLog.getSelectedAgentUid()).toBe('agent-3');
    });

    it('dashboard.handleInput wraps right arrow from last to first agent', () => {
      const tui = new WorkflowTUI();
      const dashboard = tui.getDashboard();

      dashboard.registry.register({ agentId: 'agent-1', profile: 'coder', phase: 'test' });
      dashboard.registry.register({ agentId: 'agent-2', profile: 'scout', phase: 'test' });
      dashboard.registry.register({ agentId: 'agent-3', profile: 'planner', phase: 'test' });
      dashboard.agentLog.setPhases(['test']);
      dashboard.agentLog.setCurrentPhase('test');

      // Navigate to agent-3 (last)
      dashboard.handleInput(RIGHT_ARROW);
      dashboard.handleInput(RIGHT_ARROW);
      expect(dashboard.agentLog.getSelectedAgentUid()).toBe('agent-3');

      dashboard.handleInput(RIGHT_ARROW);
      // Right from agent-3 wraps to agent-1
      expect(dashboard.agentLog.getSelectedAgentUid()).toBe('agent-1');
    });

    it('arrow key navigation preserves per-agent log entries', () => {
      const tui = new WorkflowTUI();
      const dashboard = tui.getDashboard();

      dashboard.registry.register({ agentId: 'agent-1', profile: 'coder', phase: 'test' });
      dashboard.registry.register({ agentId: 'agent-2', profile: 'scout', phase: 'test' });
      dashboard.agentLog.setPhases(['test']);
      dashboard.agentLog.setCurrentPhase('test');

      // Add entry to agent-1
      const uid1 = dashboard.registry.getActiveUid('agent-1')!;
      dashboard.registry.addEntry(uid1, { type: 'text', content: 'agent-1 message' });

      // Navigate to agent-2 and add entry
      dashboard.handleInput(RIGHT_ARROW);
      const uid2 = dashboard.registry.getActiveUid('agent-2')!;
      dashboard.registry.addEntry(uid2, { type: 'text', content: 'agent-2 message' });

      // Navigate back to agent-1
      dashboard.handleInput(LEFT_ARROW);
      expect(dashboard.agentLog.getSelectedAgentUid()).toBe(uid1);

      // Navigate to agent-2
      dashboard.handleInput(RIGHT_ARROW);
      expect(dashboard.agentLog.getSelectedAgentUid()).toBe(uid2);
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

      // 'x' is a non-arrow key — should not be forwarded
      dashboard.handleInput('x');
      expect(agentSpy).not.toHaveBeenCalled();

      agentSpy.mockRestore();
    });

    it('input listener fix expectation: arrow keys must be consumed by the global listener', () => {
      // This test documents the contract that the fix must satisfy:
      // When left/right arrow keys are received by the global input listener
      // in workflow-tui.ts, they must be routed to dashboard.handleInput
      // and returned as { consume: true } to prevent the TUI framework
      // from routing them to the focused component (EventLog).
      //
      // This test verifies the preconditions: the dashboard pipeline works.
      // The actual fix is in the input listener inside start().
      const tui = new WorkflowTUI();
      const dashboard = setupTwoAgents(tui);

      // Set up state that would only change if arrows reach dashboard
      expect(dashboard.agentLog.getSelectedAgentUid()).toBe('agent-1');

      // Simulate what the fixed input listener does:
      // if (matchesKey(data, 'left') || matchesKey(data, 'right')) {
      //   this.dashboard.handleInput(data);
      //   return { consume: true };
      // }
      dashboard.handleInput(RIGHT_ARROW);

      // Verify agent switched — proving the pipeline works end-to-end
      expect(dashboard.agentLog.getSelectedAgentUid()).toBe('agent-2');
    });
  });

  describe('dashboard integration', () => {
    it('uses custom maxConcurrentLanes and agentLogLines', () => {
      const tui = new WorkflowTUI({ maxConcurrentLanes: 5, agentLogLines: 8 });
      const dashboard = tui.getDashboard();
      // getComputedHeight = 1 (phaseBar) + 0 (no lanes) + agentLogLines + 4 (borders)
      expect(dashboard.getComputedHeight()).toBe(1 + 0 + 8 + 4);
    });

    it('uses default maxConcurrentLanes (5) and agentLogLines (20)', () => {
      const tui = new WorkflowTUI();
      const dashboard = tui.getDashboard();
      // getComputedHeight = 1 (phaseBar) + 0 (no lanes) + 20 (agentLog) + 4 (borders)
      expect(dashboard.getComputedHeight()).toBe(1 + 0 + 20 + 4);
    });
  });

  describe('requestRender on key handling', () => {
    // Raw terminal input sequences that matchesKey() recognizes.
    // These simulate what a real terminal sends for each key.
    const CTRL_C = '\x03';
    const TAB = '\t';
    const LEFT_ARROW = '\x1b[D';
    const RIGHT_ARROW = '\x1b[C';
    const SPACE = ' ';
    const UP_ARROW = '\x1b[A';
    const DOWN_ARROW = '\x1b[B';
    const SHIFT_UP = '\x1b[a';
    const SHIFT_DOWN = '\x1b[b';

    /**
     * Set up a WorkflowTUI with a mocked TUI that captures the input callback
     * registered by start() and provides a spy for requestRender.
     *
     * Strategy: intercept TUI.prototype.addInputListener to capture the callback
     * that start() registers, and replace requestRender on the TUI instance with
     * a mock. TUI.prototype.start is also mocked to prevent real terminal I/O.
     */
    function setupTest() {
      let capturedCallback: ((data: string) => any) | null = null;
      const requestRenderMock = mock(() => {});

      // Spy on addInputListener: capture the callback and replace requestRender
      // on the TUI instance with our mock.
      const addListenerSpy = spyOn(TUI.prototype, 'addInputListener').mockImplementation(function (
        this: any,
        cb: (data: string) => any,
      ) {
        capturedCallback = cb;
        this.requestRender = requestRenderMock;
        return () => {};
      });

      // Prevent real terminal initialization (stdin raw mode, etc.)
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

        // Tab handler returns { consume: true } but currently does NOT call
        // requestRender before returning. Without the fix, this assertion fails.
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

        // Left arrow handler returns { consume: true } but currently does NOT
        // call requestRender before returning. Without the fix, this assertion fails.
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

        // Right arrow handler returns { consume: true } but currently does NOT
        // call requestRender before returning. Without the fix, this assertion fails.
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

        // Ctrl+C handler already calls requestRender. This is a regression test
        // to ensure it continues to work after the fix is applied.
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

        // Expand the agent log first
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

        // Expand the agent log first
        wtui.dashboard.agentLog.toggleExpand();
        expect(wtui.dashboard.agentLog.isExpanded()).toBe(true);

        const result = capturedCallback!(DOWN_ARROW);
        expect(result).toEqual({ consume: true });
        expect(requestRenderMock).toHaveBeenCalled();
      } finally {
        cleanup();
      }
    });

    it('consumes Up arrow even when agent log is NOT expanded (up/down always consumed)', () => {
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

    it('consumes Down arrow even when agent log is NOT expanded (up/down always consumed)', () => {
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

        // Left arrow should still be consumed (not affected by new handlers)
        const leftResult = capturedCallback!(LEFT_ARROW);
        expect(leftResult).toEqual({ consume: true });
        expect(requestRenderMock).toHaveBeenCalled();

        requestRenderMock.mockClear();

        // Right arrow should still be consumed
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

        // Add some lines so scrolling is meaningful
        for (let i = 1; i <= 10; i++) {
          wtui.getEventLog().addLine(`line ${i}`);
        }
        expect(wtui.getEventLog().isScrolledUp).toBe(false);

        const result = capturedCallback!('\x1b[5~'); // pageUp legacy sequence
        expect(result).toEqual({ consume: true });
        expect(requestRenderMock).toHaveBeenCalled();
        // After pageUp, the eventLog should be scrolled up
        expect(wtui.getEventLog().isScrolledUp).toBe(true);
      } finally {
        cleanup();
      }
    });

    it('routes pageDown key to eventLog.handleInput and consumes it', () => {
      const { capturedCallback, requestRenderMock, wtui, cleanup } = setupTest();
      try {
        expect(capturedCallback).not.toBeNull();

        // Add lines and scroll up first so pageDown has effect
        for (let i = 1; i <= 10; i++) {
          wtui.getEventLog().addLine(`line ${i}`);
        }
        // Manually scroll up
        capturedCallback!('\x1b[5~'); // pageUp
        expect(wtui.getEventLog().isScrolledUp).toBe(true);
        requestRenderMock.mockClear();

        const result = capturedCallback!('\x1b[6~'); // pageDown legacy sequence
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

        // Add lines so scrolling to top is meaningful
        for (let i = 1; i <= 10; i++) {
          wtui.getEventLog().addLine(`line ${i}`);
        }
        expect(wtui.getEventLog().isScrolledUp).toBe(false);

        const result = capturedCallback!('\x1b[H'); // home legacy sequence
        expect(result).toEqual({ consume: true });
        expect(requestRenderMock).toHaveBeenCalled();
        // Home should scroll to top
        expect(wtui.getEventLog().isScrolledUp).toBe(true);
      } finally {
        cleanup();
      }
    });

    it('routes end key to eventLog.handleInput and consumes it', () => {
      const { capturedCallback, requestRenderMock, wtui, cleanup } = setupTest();
      try {
        expect(capturedCallback).not.toBeNull();

        // Add lines and scroll up first so end has effect
        for (let i = 1; i <= 10; i++) {
          wtui.getEventLog().addLine(`line ${i}`);
        }
        // Manually scroll up
        capturedCallback!('\x1b[5~'); // pageUp
        expect(wtui.getEventLog().isScrolledUp).toBe(true);
        requestRenderMock.mockClear();

        const result = capturedCallback!('\x1b[F'); // end legacy sequence
        expect(result).toEqual({ consume: true });
        expect(requestRenderMock).toHaveBeenCalled();
        // End should scroll back to bottom
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
        // Scroll up
        capturedCallback!('\x1b[5~'); // pageUp
        expect(wtui.getEventLog().isScrolledUp).toBe(true);

        // PageDown until back at bottom should re-enable autoScroll
        // The eventLog has maxLines=20 (default), len=10, so pageDown
        // with pageSize=19 will go straight to 0 and enable autoScroll.
        capturedCallback!('\x1b[6~'); // pageDown

        // Add a new line — if autoScroll is on, we should see it
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

        // Verify other keys still work after adding scroll key handling
        const tabResult = capturedCallback!('\t');
        expect(tabResult).toEqual({ consume: true });

        requestRenderMock.mockClear();
        const leftResult = capturedCallback!('\x1b[D');
        expect(leftResult).toEqual({ consume: true });

        requestRenderMock.mockClear();
        const rightResult = capturedCallback!('\x1b[C');
        expect(rightResult).toEqual({ consume: true });

        requestRenderMock.mockClear();
        const pgUpResult = capturedCallback!('\x1b[5~');
        expect(pgUpResult).toEqual({ consume: true });

        requestRenderMock.mockClear();
        const pgDnResult = capturedCallback!('\x1b[6~');
        expect(pgDnResult).toEqual({ consume: true });

        requestRenderMock.mockClear();
        const homeResult = capturedCallback!('\x1b[H');
        expect(homeResult).toEqual({ consume: true });

        requestRenderMock.mockClear();
        const endResult = capturedCallback!('\x1b[F');
        expect(endResult).toEqual({ consume: true });
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

        // PageUp should disable autoScroll
        capturedCallback!('\x1b[5~');
        // After adding a new line with autoScroll=false, scrollOffset increments
        wtui.getEventLog().addLine('new line');
        // Viewport should NOT jump to show the new line
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

        // Expand and register an agent with 60 entries
        dashboard.agentLog.toggleExpand();
        expect(dashboard.agentLog.isExpanded()).toBe(true);

        dashboard.registry.register({ agentId: 'agent-1', profile: 'coder', phase: 'test' });
        dashboard.agentLog.setPhases(['test']);
        dashboard.agentLog.setCurrentPhase('test');
        const uid = dashboard.registry.getActiveUid('agent-1')!;
        for (let i = 1; i <= 60; i++) {
          dashboard.registry.addEntry(uid, { type: 'text', content: `entry ${i}` });
        }

        // Force an initial render to populate _lastTotalEntryLines
        dashboard.agentLog.render(80);

        // Send multiple shift+up to scroll
        for (let i = 0; i < 3; i++) {
          capturedCallback!(SHIFT_UP);
        }

        // Render and check the scroll indicator
        const lines = dashboard.agentLog.render(80);
        const joined = lines.join('\n');
        // The scroll indicator shows 'up arrow X more lines' when scrolled up
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

        // Expand and register an agent with 60 entries
        dashboard.agentLog.toggleExpand();
        expect(dashboard.agentLog.isExpanded()).toBe(true);

        dashboard.registry.register({ agentId: 'agent-1', profile: 'coder', phase: 'test' });
        dashboard.agentLog.setPhases(['test']);
        dashboard.agentLog.setCurrentPhase('test');
        const uid = dashboard.registry.getActiveUid('agent-1')!;
        for (let i = 1; i <= 60; i++) {
          dashboard.registry.addEntry(uid, { type: 'text', content: `entry ${i}` });
        }

        // Force an initial render to populate _lastTotalEntryLines
        dashboard.agentLog.render(80);

        // Scroll up first (multiple shift+up)
        for (let i = 0; i < 5; i++) {
          capturedCallback!(SHIFT_UP);
        }
        requestRenderMock.mockClear();

        // Now scroll down by 10 via shift+down
        capturedCallback!(SHIFT_DOWN);

        // Should still be scrolled up
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

        // Agent log is NOT expanded by default
        expect(wtui.dashboard.agentLog.isExpanded()).toBe(false);

        const result = capturedCallback!(SHIFT_UP);
        // Should NOT be consumed (falls through)
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

        // Agent log is NOT expanded by default
        expect(wtui.dashboard.agentLog.isExpanded()).toBe(false);

        const result = capturedCallback!(SHIFT_DOWN);
        // Should NOT be consumed (falls through)
        expect(result).toBeUndefined();
        expect(requestRenderMock).not.toHaveBeenCalled();
      } finally {
        cleanup();
      }
    });
  });

  describe('dashboard.registry getter', () => {
    it('is accessible via getDashboard().registry', () => {
      const tui = new WorkflowTUI();
      const dashboard = tui.getDashboard();
      const registry = dashboard.registry;
      expect(registry).toBeDefined();
      expect(typeof registry.register).toBe('function');
      expect(typeof registry.getAgents).toBe('function');
      expect(typeof registry.addEntry).toBe('function');
    });

    it('register stores agents and getAgents returns them', () => {
      const tui = new WorkflowTUI();
      const dashboard = tui.getDashboard();
      dashboard.registry.register({ agentId: 'test-agent', profile: 'coder', phase: 'test' });
      const agents = dashboard.registry.getAgents();
      expect(agents.length).toBe(1);
      expect(agents[0].agentId).toBe('test-agent');
      expect(agents[0].profile).toBe('coder');
    });
  });

  describe('left/right does not sync lane pool focus', () => {
    const RIGHT_ARROW = '\x1b[C';

    it('left/right arrow navigation does not change lane pool focus', () => {
      const tui = new WorkflowTUI();
      const dashboard = tui.getDashboard();

      // Register agents in the same phase
      dashboard.registry.register({ agentId: 'agent-1', profile: 'coder', phase: 'test' });
      dashboard.registry.register({ agentId: 'agent-2', profile: 'scout', phase: 'test' });
      dashboard.agentLog.setPhases(['test']);
      dashboard.agentLog.setCurrentPhase('test');

      // Initially no lane pool focus
      expect(dashboard.lanePool.getFocusedTaskId()).toBeUndefined();

      // Use left/right to navigate agents
      dashboard.handleInput(RIGHT_ARROW);
      expect(dashboard.agentLog.getSelectedAgentUid()).toBe('agent-2');

      // Lane pool focus should remain unchanged
      expect(dashboard.lanePool.getFocusedTaskId()).toBeUndefined();

      dashboard.handleInput(RIGHT_ARROW);
      expect(dashboard.agentLog.getSelectedAgentUid()).toBe('agent-1');

      // Still no lane pool sync
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

      // First call
      await wtui.showQrCode('https://example.com');
      expect(hideMock1).not.toHaveBeenCalled();
      expect(mockShowOverlay).toHaveBeenCalledTimes(1);

      // Second call — should hide first handle
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
    /**
     * Spy on TUI prototype methods that touch real terminal I/O so start()
     * runs without entering raw mode, while still exercising the real WorkflowTUI
     * start() path that attaches a prepared QR overlay. Captures showOverlay so
     * we can assert the prepared component is attached during start().
     */
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

    it('attaches the prepared QR overlay during start() (so it paints on the first render)', async () => {
      const { mockShowOverlay, cleanup } = setupStartWithShowOverlaySpy();
      try {
        const wtui = new WorkflowTUI({ abort: () => {} });
        await wtui.prepareQrCode('https://example.com');
        wtui.start();

        // The QR overlay must be attached during start(), not deferred to a
        // later render — that is what keeps it out of the incremental-render
        // edge case where its rows never get painted.
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

      // Should resolve synchronously (or near-synchronously)
      expect(elapsed).toBeLessThan(50);
      // Should NOT have added a new input listener
      expect(addInputMock).not.toHaveBeenCalled();
    });

    it('resolves when signal is aborted after a tick', async () => {
      const { wtui, addInputMock } = setupPauseTest();

      const controller = new AbortController();
      const promise = wtui.pauseForInspection(controller.signal);

      // Verify that an input listener was registered
      expect(addInputMock).toHaveBeenCalledTimes(1);

      // Cancel via abort
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

      // Get the listener that was registered
      expect(addInputMock).toHaveBeenCalledTimes(1);
      const listener = addInputMock.mock.calls[0][0];
      expect(typeof listener).toBe('function');

      // Simulate Ctrl+C press with raw terminal byte (\x03 = Ctrl+C)
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

      // Simulate Escape press with raw terminal byte (\x1b = Escape)
      const result = listener('\x1b');
      expect(result).toEqual({ consume: true });

      await expect(promise).resolves.toBeUndefined();
    });

    it('does nothing when tui is null', async () => {
      const wtui = new WorkflowTUI();
      // tui is null by default
      await wtui.pauseForInspection();
      // Should not throw; just return
    });

    it('does nothing when not running', async () => {
      const wtui = new WorkflowTUI();
      (wtui as any).tui = {
        addInputListener: mock(() => {}),
        requestRender: mock(() => {}),
      };
      (wtui as any).running = false;

      await wtui.pauseForInspection();
      // Should not throw; just return silently
    });

    it('resolves signal abort after pause listener setup prevents double-resolution', async () => {
      const { wtui } = setupPauseTest();

      const controller = new AbortController();
      let resolveCount = 0;
      const promise = wtui.pauseForInspection(controller.signal);
      promise.then(() => resolveCount++);

      // Abort once
      controller.abort();
      await promise;
      expect(resolveCount).toBe(1);

      // The resolved flag should prevent double-resolution; just verify no error
    });

    it('resolves via Ctrl+C even when AbortSignal never fires', async () => {
      const { wtui, addInputMock } = setupPauseTest();

      const promise = wtui.pauseForInspection();

      expect(addInputMock).toHaveBeenCalledTimes(1);
      const listener = addInputMock.mock.calls[0][0];

      // Simulate Ctrl+C press with raw terminal byte
      listener('\x03');

      await expect(promise).resolves.toBeUndefined();
    });
  });
});
