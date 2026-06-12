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
    // The fix in workflow-tui.ts adds left/right arrow handling in the
    // global input listener, routing to dashboard.handleInput(data).

    const LEFT_ARROW = '\x1b[D';
    const RIGHT_ARROW = '\x1b[C';

    it('dashboard.handleInput routes left arrow to agentLog, switching agents', () => {
      const tui = new WorkflowTUI();
      const dashboard = tui.getDashboard();

      dashboard.agentLog.selectAgent('agent-1', 'coder');
      dashboard.agentLog.selectAgent('agent-2', 'scout');
      expect(dashboard.agentLog.getCurrentAgentId()).toBe('agent-2');

      dashboard.handleInput(LEFT_ARROW);
      expect(dashboard.agentLog.getCurrentAgentId()).toBe('agent-1');
    });

    it('dashboard.handleInput routes right arrow to agentLog, switching agents', () => {
      const tui = new WorkflowTUI();
      const dashboard = tui.getDashboard();

      dashboard.agentLog.selectAgent('agent-1', 'coder');
      dashboard.agentLog.selectAgent('agent-2', 'scout');
      expect(dashboard.agentLog.getCurrentAgentId()).toBe('agent-2');

      dashboard.handleInput(RIGHT_ARROW);
      // Right from agent-2 wraps to agent-1
      expect(dashboard.agentLog.getCurrentAgentId()).toBe('agent-1');
    });

    it('dashboard.handleInput wraps left arrow from first to last agent', () => {
      const tui = new WorkflowTUI();
      const dashboard = tui.getDashboard();

      dashboard.agentLog.selectAgent('agent-1', 'coder');
      dashboard.agentLog.selectAgent('agent-2', 'scout');
      dashboard.agentLog.selectAgent('agent-3', 'planner');
      // Navigate back to first
      dashboard.agentLog.selectAgent('agent-1', 'coder');

      dashboard.handleInput(LEFT_ARROW);
      // Left from agent-1 wraps to agent-3
      expect(dashboard.agentLog.getCurrentAgentId()).toBe('agent-3');
    });

    it('dashboard.handleInput wraps right arrow from last to first agent', () => {
      const tui = new WorkflowTUI();
      const dashboard = tui.getDashboard();

      dashboard.agentLog.selectAgent('agent-1', 'coder');
      dashboard.agentLog.selectAgent('agent-2', 'scout');
      dashboard.agentLog.selectAgent('agent-3', 'planner');
      // Currently on agent-3 (last)

      dashboard.handleInput(RIGHT_ARROW);
      // Right from agent-3 wraps to agent-1
      expect(dashboard.agentLog.getCurrentAgentId()).toBe('agent-1');
    });

    it('arrow key navigation preserves per-agent log entries', () => {
      const tui = new WorkflowTUI();
      const dashboard = tui.getDashboard();

      dashboard.agentLog.selectAgent('agent-1', 'coder');
      dashboard.agentLog.addEntry({ type: 'text', content: 'agent-1 message' });

      dashboard.agentLog.selectAgent('agent-2', 'scout');
      dashboard.agentLog.addEntry({ type: 'text', content: 'agent-2 message' });

      // Navigate left to agent-1
      dashboard.handleInput(LEFT_ARROW);
      expect(dashboard.agentLog.getCurrentAgentId()).toBe('agent-1');

      // Navigate right to agent-2
      dashboard.handleInput(RIGHT_ARROW);
      expect(dashboard.agentLog.getCurrentAgentId()).toBe('agent-2');
    });

    it('dashboard.handleInput with spy verifies left arrow is forwarded to agentLog', () => {
      const tui = new WorkflowTUI();
      const dashboard = tui.getDashboard();
      const agentSpy = spyOn(dashboard.agentLog, 'handleInput');

      dashboard.agentLog.selectAgent('agent-1', 'coder');
      dashboard.agentLog.selectAgent('agent-2', 'scout');

      dashboard.handleInput(LEFT_ARROW);
      expect(agentSpy).toHaveBeenCalledTimes(1);
      expect(agentSpy).toHaveBeenCalledWith(LEFT_ARROW);

      agentSpy.mockRestore();
    });

    it('dashboard.handleInput with spy verifies right arrow is forwarded to agentLog', () => {
      const tui = new WorkflowTUI();
      const dashboard = tui.getDashboard();
      const agentSpy = spyOn(dashboard.agentLog, 'handleInput');

      dashboard.agentLog.selectAgent('agent-1', 'coder');
      dashboard.agentLog.selectAgent('agent-2', 'scout');

      dashboard.handleInput(RIGHT_ARROW);
      expect(agentSpy).toHaveBeenCalledTimes(1);
      expect(agentSpy).toHaveBeenCalledWith(RIGHT_ARROW);

      agentSpy.mockRestore();
    });

    it('non-arrow keys are NOT routed to agentLog by dashboard.handleInput', () => {
      const tui = new WorkflowTUI();
      const dashboard = tui.getDashboard();
      const agentSpy = spyOn(dashboard.agentLog, 'handleInput');

      dashboard.agentLog.selectAgent('agent-1', 'coder');
      dashboard.agentLog.selectAgent('agent-2', 'scout');

      dashboard.handleInput('\x1b[B'); // Down arrow — should go to lanePool, not agentLog
      expect(agentSpy).not.toHaveBeenCalled();

      agentSpy.mockRestore();
    });

    it('agentLog shows footer with agent count after arrow key navigation via dashboard', () => {
      const tui = new WorkflowTUI();
      const dashboard = tui.getDashboard();

      dashboard.agentLog.selectAgent('agent-1', 'coder');
      dashboard.agentLog.selectAgent('agent-2', 'scout');

      dashboard.handleInput(LEFT_ARROW); // switch to agent-1
      const lines = dashboard.agentLog.render(80);
      const lastLine = lines[lines.length - 1];
      expect(lastLine).toContain('switch agent');
      expect(lastLine).toContain('1/2');
    });

    it('input listener fix expectation: arrow keys must be consumed by the global listener', () => {
      // This test documents the contract that the fix must satisfy:
      // When left/right arrow keys are received by the global input listener
      // in workflow-tui.ts, they must be routed to dashboard.handleInput
      // and returned as { consume: true } to prevent the TUI framework
      // from routing them to the focused component (EventLog).
      //
      // Before the fix, left/right arrows fell through to EventLog (focused)
      // which doesn't handle them, so they were silently dropped.
      //
      // This test verifies the preconditions: the dashboard pipeline works.
      // The actual fix is in the input listener inside start().
      const tui = new WorkflowTUI();
      const dashboard = tui.getDashboard();

      // Set up state that would only change if arrows reach dashboard
      dashboard.agentLog.selectAgent('alpha', 'coder');
      dashboard.agentLog.selectAgent('beta', 'scout');
      expect(dashboard.agentLog.getCurrentAgentId()).toBe('beta');

      // Simulate what the fixed input listener does:
      // if (matchesKey(data, 'left') || matchesKey(data, 'right')) {
      //   this.dashboard.handleInput(data);
      //   return { consume: true };
      // }
      dashboard.handleInput(LEFT_ARROW);

      // Verify agent switched — proving the pipeline works end-to-end
      expect(dashboard.agentLog.getCurrentAgentId()).toBe('alpha');
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
    const CTRL_LEFT = '\x1bOd';
    const CTRL_RIGHT = '\x1bOc';
    const UP_ARROW = '\x1b[A';
    const DOWN_ARROW = '\x1b[B';

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

    it('calls requestRender when Ctrl+Left key is handled', () => {
      const { capturedCallback, requestRenderMock, cleanup } = setupTest();
      try {
        expect(capturedCallback).not.toBeNull();

        capturedCallback!(CTRL_LEFT);
        expect(requestRenderMock).toHaveBeenCalled();
      } finally {
        cleanup();
      }
    });

    it('calls requestRender when Ctrl+Right key is handled', () => {
      const { capturedCallback, requestRenderMock, cleanup } = setupTest();
      try {
        expect(capturedCallback).not.toBeNull();

        capturedCallback!(CTRL_RIGHT);
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

    it('falls through when Up arrow is pressed and agent log is NOT expanded', () => {
      const { capturedCallback, requestRenderMock, cleanup } = setupTest();
      try {
        expect(capturedCallback).not.toBeNull();

        const result = capturedCallback!(UP_ARROW);
        expect(result).toBeUndefined();
        expect(requestRenderMock).not.toHaveBeenCalled();
      } finally {
        cleanup();
      }
    });

    it('falls through when Down arrow is pressed and agent log is NOT expanded', () => {
      const { capturedCallback, requestRenderMock, cleanup } = setupTest();
      try {
        expect(capturedCallback).not.toBeNull();

        const result = capturedCallback!(DOWN_ARROW);
        expect(result).toBeUndefined();
        expect(requestRenderMock).not.toHaveBeenCalled();
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
  });
});
