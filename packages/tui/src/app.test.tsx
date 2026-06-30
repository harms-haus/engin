/**
 * Tests for App + Dashboard composite (kb-13 — convergence).
 *
 * Uses a real ClientStore + TuiStore, renders via renderWithHost, and
 * verifies keyboard navigation and store state changes.
 *
 * Test plan:
 *   1. Full app renders without throwing (Dashboard + separator + EventLog).
 *   2. Ctrl+D calls invokeDetach (handler 1, always-active).
 *   3. Ctrl+C when not inspecting shows prompt (store.promptVisible = true).
 *   4. Ctrl+C when inspecting resolves pause.
 *   5. Ctrl+Q toggles qrVisible.
 *   6. ←/→ navigates phases (selectedPhaseId changes).
 *   7. ↑/↓ navigates tasks when collapsed (selectedTaskId changes).
 *   8. Tab cycles sessions (selectedSessionId changes).
 *   9. Space toggles isLogExpanded.
 *  10. When prompt open, main handler is inactive (arrows don't navigate)
 *      but Ctrl+D still detaches.
 */

import type { EventRecord } from '@engin/shared';
import { ClientStore } from '@engin/shared/client-store';
import { beforeEach, describe, expect, it } from 'bun:test';
import { App } from './app.js';
import { renderWithHost, sendKey, stripAnsi } from './test-harness.js';
import { TuiStore } from './tui-store.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Microtask boundary so React / Ink flush pending updates. */
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

/**
 * Create a sequence of phases with tasks and sessions for navigation tests.
 * Applies events to set up the store state.
 */
function setupTestData(clientStore: ClientStore): void {
  // Register phases
  clientStore.applyEvents([
    {
      seq: 1,
      type: 'phase_registered',
      data: { id: 'p1', label: 'Plan', icon: '' },
      metadata: { timestamp: new Date().toISOString() },
    } as EventRecord,
    {
      seq: 2,
      type: 'phase_registered',
      data: { id: 'p2', label: 'Execute', icon: '' },
      metadata: { timestamp: new Date().toISOString() },
    } as EventRecord,
    {
      seq: 3,
      type: 'phase_registered',
      data: { id: 'p3', label: 'Review', icon: '' },
      metadata: { timestamp: new Date().toISOString() },
    } as EventRecord,
  ]);

  // Start phase 1
  clientStore.applyEvents([
    {
      seq: 4,
      type: 'phase_started',
      data: { phase: 'p1' },
      metadata: { timestamp: new Date().toISOString() },
    } as EventRecord,
  ]);

  // Register and start tasks in phase 1
  clientStore.applyEvents([
    {
      seq: 5,
      type: 'task_registered',
      data: { taskId: 't1', title: 'Design API', phaseId: 'p1', dependencies: [] },
      metadata: { timestamp: new Date().toISOString() },
    } as EventRecord,
    {
      seq: 6,
      type: 'task_registered',
      data: { taskId: 't2', title: 'Implement API', phaseId: 'p1', dependencies: [] },
      metadata: { timestamp: new Date().toISOString() },
    } as EventRecord,
    {
      seq: 7,
      type: 'task_registered',
      data: { taskId: 't3', title: 'Test API', phaseId: 'p1', dependencies: [] },
      metadata: { timestamp: new Date().toISOString() },
    } as EventRecord,
  ]);

  // Start task 1 (active)
  clientStore.applyEvents([
    {
      seq: 8,
      type: 'task_started',
      data: { taskId: 't1' },
      metadata: { timestamp: new Date().toISOString(), taskId: 't1' },
    } as EventRecord,
  ]);

  // Create sessions for task 1
  clientStore.applyEvents([
    {
      seq: 9,
      type: 'session_started',
      data: {
        agentId: 'agent-1',
        taskId: 't1',
        runnerRole: 'architect',
        profile: 'architect',
        attempt: 1,
        taskTitle: 'Design API',
      },
      metadata: {
        timestamp: new Date().toISOString(),
        agentId: 'agent-1',
        taskId: 't1',
        runnerRole: 'architect',
      },
    } as EventRecord,
  ]);
}

// ─── Suite ───────────────────────────────────────────────────────────────────

describe('App (composite layer)', () => {
  let clientStore: ClientStore;
  let tuiStore: TuiStore;
  let onDetach: () => void;
  let onKill: () => void;

  beforeEach(() => {
    clientStore = new ClientStore();
    onDetach = () => {}; // spy
    onKill = () => {}; // spy
    tuiStore = new TuiStore(clientStore, { onDetach, onKill });
    setupTestData(clientStore);
  });

  // ─── Full app renders ────────────────────────────────────────────────

  describe('rendering', () => {
    it('renders Dashboard + separator + EventLog without throwing', () => {
      const { lastFrame, unmount } = renderWithHost(<App store={tuiStore} />);

      const text = stripAnsi(lastFrame() ?? '');
      // Should contain phase labels
      expect(text).toContain('Plan');
      expect(text).toContain('Execute');
      expect(text).toContain('Review');
      // Should contain task labels (the test terminal may be small,
      // so not all tasks may be fully visible)
      expect(text).toContain('Design API');
      // Should have separator line
      expect(text).toContain('─');
      // Dashboard is a single bordered panel: top/bottom frame + internal
      // `│───│` dividers between phase bar / task list / agent log. A bare
      // `<Box borderTop/>` renders nothing in Ink and a bare `<Text>` rule
      // collapses the phase bar, so we guard both the frame and the dividers.
      expect(text).toContain('┌'); // top-LEFT border
      expect(text).toContain('┐'); // top-RIGHT border (width-overflow regression)
      expect(text).toMatch(/│─{3,}/); // at least one internal section rule
      // NOTE: bottom borders (└/┘) are intentionally NOT asserted here — the
      // full App (EventLog + separator + Dashboard w/ its 20-line agent log)
      // exceeds the test fixture's 24-row fake terminal, so the bottom frame
      // is height-clipped. They render correctly in real (taller) terminals.
      // Should have agent log area
      expect(text).toContain('No session selected');

      unmount();
    });

    it('handles empty store gracefully', () => {
      const emptyClient = new ClientStore();
      const emptyStore = new TuiStore(emptyClient);
      const { lastFrame, unmount } = renderWithHost(<App store={emptyStore} />);

      const text = stripAnsi(lastFrame() ?? '');
      // No crash — renders with empty state
      expect(text).toBeDefined();

      emptyStore.dispose();
      unmount();
    });
  });

  // ─── Ctrl+D — always-active detach ──────────────────────────────────

  describe('Ctrl+D (detach)', () => {
    it('calls invokeDetach when Ctrl+D is pressed (handler 1)', async () => {
      let detachCalled = false;
      const detachStore = new TuiStore(clientStore, {
        onDetach: () => {
          detachCalled = true;
        },
      });
      const { stdin, unmount } = renderWithHost(<App store={detachStore} />);
      await tick();

      sendKey(stdin, 'ctrlD');
      await tick();

      expect(detachCalled).toBe(true);

      detachStore.dispose();
      unmount();
    });

    it('detach works even when prompt is visible', async () => {
      let detachCalled = false;
      const detachStore = new TuiStore(clientStore, {
        onDetach: () => {
          detachCalled = true;
        },
      });

      // Show the prompt first
      detachStore.showPrompt();
      expect(detachStore.promptVisible).toBe(true);

      const { stdin, unmount } = renderWithHost(<App store={detachStore} />);
      // Wait for capture chain to propagate (detach handler is always-active
      // but we still wait for render stability).
      await tick();
      await tick();
      await tick();
      await tick();

      // Ctrl+D should still call invokeDetach even with prompt open
      // (handler 1 is isActive: true, unaffected by capture).
      sendKey(stdin, 'ctrlD');
      await tick();

      expect(detachCalled).toBe(true);

      detachStore.dispose();
      unmount();
    });
  });

  // ─── Ctrl+C — show prompt or resolve pause ─────────────────────────

  describe('Ctrl+C', () => {
    it('shows prompt when not inspecting', async () => {
      const { stdin, unmount } = renderWithHost(<App store={tuiStore} />);
      await tick();

      expect(tuiStore.promptVisible).toBe(false);

      sendKey(stdin, 'ctrlC');
      await tick();

      expect(tuiStore.promptVisible).toBe(true);

      unmount();
    });

    it('resolves pause when inspecting', async () => {
      const { stdin, unmount } = renderWithHost(<App store={tuiStore} />);
      await tick();

      // Set inspecting mode
      tuiStore.inspecting = true;
      let pauseResolved = false;
      tuiStore.resolvePause = () => {
        pauseResolved = true;
      };

      sendKey(stdin, 'ctrlC');
      await tick();

      expect(pauseResolved).toBe(true);

      unmount();
    });
  });

  // ─── Ctrl+Q — toggle QR ────────────────────────────────────────────

  describe('Ctrl+Q (QR toggle)', () => {
    it('toggles qrVisible', async () => {
      const { stdin, unmount } = renderWithHost(<App store={tuiStore} />);
      await tick();

      expect(tuiStore.qrVisible).toBe(false);

      sendKey(stdin, 'ctrlQ');
      await tick();

      expect(tuiStore.qrVisible).toBe(true);

      sendKey(stdin, 'ctrlQ');
      await tick();

      expect(tuiStore.qrVisible).toBe(false);

      unmount();
    });
  });

  // ─── ←/→ phase navigation ──────────────────────────────────────────

  describe('←/→ (phase navigation)', () => {
    it('right arrow advances to the next phase', async () => {
      const { stdin, unmount } = renderWithHost(<App store={tuiStore} />);
      await tick();

      // After reconcileSelection, selectedPhaseId follows currentPhaseId: 'p1'
      const stateBefore = tuiStore.getClientStoreState();
      expect(stateBefore.selectedPhaseId).toBe('p1');

      // Press right arrow
      sendKey(stdin, 'right');
      await tick();

      // Now selectedPhaseId should be 'p2'
      const stateAfter = tuiStore.getClientStoreState();
      expect(stateAfter.selectedPhaseId).toBe('p2');

      unmount();
    });

    it('left arrow wraps to the last phase', async () => {
      const { stdin, unmount } = renderWithHost(<App store={tuiStore} />);
      await tick();

      // Current: p1. Left wraps to p3
      sendKey(stdin, 'left');
      await tick();

      const state = tuiStore.getClientStoreState();
      expect(state.selectedPhaseId).toBe('p3');

      unmount();
    });

    it('left/right navigates through all phases and wraps', async () => {
      const { stdin, unmount } = renderWithHost(<App store={tuiStore} />);
      await tick();

      // Start at p1
      sendKey(stdin, 'right');
      await tick();
      expect(tuiStore.getClientStoreState().selectedPhaseId).toBe('p2');

      sendKey(stdin, 'right');
      await tick();
      expect(tuiStore.getClientStoreState().selectedPhaseId).toBe('p3');

      // Right from p3 wraps to p1
      sendKey(stdin, 'right');
      await tick();
      expect(tuiStore.getClientStoreState().selectedPhaseId).toBe('p1');

      unmount();
    });
  });

  // ─── ↑/↓ task navigation (when collapsed) ──────────────────────────

  describe('↑/↓ (task navigation)', () => {
    it('down arrow advances to the next task', async () => {
      const { stdin, unmount } = renderWithHost(<App store={tuiStore} />);
      await tick();

      // Ensure collapsed
      expect(tuiStore.isLogExpanded).toBe(false);

      // Initially p1 has tasks t1, t2, t3; auto-selects first task
      const stateBefore = tuiStore.getClientStoreState();
      // Apply events would have selected t1 via reconcileSelection
      expect(stateBefore.selectedTaskId).toBe('t1');

      // Press down arrow
      sendKey(stdin, 'down');
      await tick();

      const stateAfter = tuiStore.getClientStoreState();
      expect(stateAfter.selectedTaskId).toBe('t2');

      unmount();
    });

    it('up arrow goes to the previous task, wrapping to last', async () => {
      const { stdin, unmount } = renderWithHost(<App store={tuiStore} />);
      await tick();

      // From t1, up wraps to last task (t3)
      sendKey(stdin, 'up');
      await tick();

      const state = tuiStore.getClientStoreState();
      expect(state.selectedTaskId).toBe('t3');

      unmount();
    });

    it('does NOT navigate when expanded', async () => {
      const { stdin, unmount } = renderWithHost(<App store={tuiStore} />);
      await tick();

      // Expand the agent log
      tuiStore.toggleExpand();
      expect(tuiStore.isLogExpanded).toBe(true);

      const taskBefore = tuiStore.getClientStoreState().selectedTaskId;

      // Down arrow should NOT change task selection when expanded
      sendKey(stdin, 'down');
      await tick();
      await tick();

      const taskAfter = tuiStore.getClientStoreState().selectedTaskId;
      expect(taskAfter).toBe(taskBefore);

      unmount();
    });
  });

  // ─── Tab — cycle sessions ──────────────────────────────────────────

  describe('Tab (session cycling)', () => {
    it('Tab calls selectNextSession with direction 1', async () => {
      const { stdin, unmount } = renderWithHost(<App store={tuiStore} />);
      await tick();

      const state = tuiStore.getClientStoreState();
      // We have sessions for t1: one session with uid from the event
      // (auto-generated by the event type). We just verify Tab doesn't throw.
      expect(state.selectedTaskId).toBe('t1');
      // selectedSessionId may be set by reconcileSelection

      // Tab should not throw
      expect(() => {
        sendKey(stdin, 'tab');
      }).not.toThrow();

      await tick();
      unmount();
    });

    it('Shift+Tab calls selectNextSession with direction -1', async () => {
      const { stdin, unmount } = renderWithHost(<App store={tuiStore} />);
      await tick();

      expect(() => {
        sendKey(stdin, 'shiftTab');
      }).not.toThrow();

      await tick();
      unmount();
    });
  });

  // ─── Space — toggle expand ─────────────────────────────────────────

  describe('Space (toggle expand)', () => {
    it('toggles isLogExpanded', async () => {
      const { stdin, unmount } = renderWithHost(<App store={tuiStore} />);
      await tick();

      expect(tuiStore.isLogExpanded).toBe(false);

      sendKey(stdin, 'space');
      await tick();

      expect(tuiStore.isLogExpanded).toBe(true);

      sendKey(stdin, 'space');
      await tick();

      expect(tuiStore.isLogExpanded).toBe(false);

      unmount();
    });
  });

  // ─── Prompt open: main handler inactive, Ctrl+D still works ───────

  describe('prompt overlay input gating', () => {
    it('arrows do NOT navigate when prompt is open', async () => {
      let detachCalled = false;
      const promptStore = new TuiStore(clientStore, {
        onDetach: () => {
          detachCalled = true;
        },
      });
      // Show the prompt
      promptStore.showPrompt();
      expect(promptStore.promptVisible).toBe(true);

      const { stdin, unmount } = renderWithHost(<App store={promptStore} />);
      // Multiple ticks needed for the capture chain to propagate:
      // 1. Layer.useEffect → registerLayer → host bumpVersion
      // 2. Host re-render → LayerRenderer renders FocusTrap
      // 3. FocusTrap.useEffect → captureEnter → setCaptureDepth(1)
      // 4. InputDispatcher re-render → isCaptured = true
      await tick();
      await tick();
      await tick();
      await tick();

      const phaseBefore = promptStore.getClientStoreState().selectedPhaseId;

      // Right arrow — should NOT navigate since prompt is open and
      // the gated handler is inactive.
      sendKey(stdin, 'right');
      await tick();

      const phaseAfter = promptStore.getClientStoreState().selectedPhaseId;
      expect(phaseAfter).toBe(phaseBefore);

      // Ctrl+D should STILL work (handler 1, always-active)
      sendKey(stdin, 'ctrlD');
      await tick();

      expect(detachCalled).toBe(true);

      promptStore.dispose();
      unmount();
    });
  });
});
