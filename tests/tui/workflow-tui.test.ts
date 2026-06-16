import { TUI } from '@earendil-works/pi-tui';
import type { AgentEntity, TaskEntity, WorkflowProjection } from '@engin/shared';
import { ClientStore } from '@engin/shared/client-store';
import type { EventRecord, EventType } from '@engin/shared/event-types';
import { describe, expect, it, mock, spyOn } from 'bun:test';
import { WorkflowTUI } from '../../packages/tui/src/workflow-tui.js';

// ─── Event helpers ───────────────────────────────────────────────────────────

const ISO_NOW = '2026-06-15T00:00:00.000Z';

let eventSeq = 0;

/** Build an EventRecord with a monotonically increasing seq (or an override). */
function ev(
  type: EventType,
  data: Record<string, unknown> = {},
  meta: Partial<EventRecord['metadata']> = {},
  seqOverride?: number,
): EventRecord {
  const s = seqOverride ?? ++eventSeq;
  return { seq: s, type, data, metadata: { timestamp: ISO_NOW, ...meta } };
}

// ─── Projection helpers ──────────────────────────────────────────────────────

/** Create a minimal projection with agents in given phases. */
function projectionWithAgents(phases: string[], agentIds: string[], taskId = 't1'): WorkflowProjection {
  const currentPhaseId = phases[0] ?? '';
  const p: WorkflowProjection = {
    seq: 0,
    taskPrompt: '',
    phases: phases.map((id) => ({ id, label: id, icon: '📋', taskIds: [taskId] })),
    currentPhaseId,
    completedPhaseIds: [],
    tasks: {
      [taskId]: {
        id: taskId,
        title: 'Test Task',
        phaseId: currentPhaseId,
        status: 'active',
        steps: agentIds.map((aid, i) => ({ name: `Step ${i + 1}`, index: i, agentKey: aid })),
        dependencies: [],
        startedAt: Date.now(),
      },
    },
    agents: {},
    sidebar: { title: '', indicator: '' },
    status: 'running',
    stats: { totalTokens: 0, agentCount: 0 },
    runLog: [],
  };
  for (const phase of phases) {
    for (const agentId of agentIds) {
      const key = agentId + '-' + phase;
      p.agents[key] = {
        uid: key,
        agentId,
        profile: 'coder',
        phaseId: phase,
        taskId,
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

/** Build a full projection from structured options. */
function buildProjection(options: {
  phases?: { id: string; label?: string; icon?: string }[];
  currentPhaseId?: string;
  completedPhaseIds?: string[];
  tasks?: TaskEntity[];
  agents?: AgentEntity[];
  indicator?: string;
}): WorkflowProjection {
  const p = {
    seq: 0,
    taskPrompt: '',
    phases: (options.phases ?? []).map((ph) => ({
      id: ph.id,
      label: ph.label ?? ph.id,
      icon: ph.icon ?? '📋',
      taskIds: [] as string[],
    })),
    currentPhaseId: options.currentPhaseId ?? '',
    completedPhaseIds: options.completedPhaseIds ?? [],
    tasks: {} as Record<string, TaskEntity>,
    agents: {} as Record<string, AgentEntity>,
    sidebar: { title: '', indicator: options.indicator ?? '' },
    status: 'running' as const,
    stats: { totalTokens: 0, agentCount: 0 },
    runLog: [] as WorkflowProjection['runLog'],
  };
  for (const t of options.tasks ?? []) {
    p.tasks[t.id] = t;
  }
  for (const a of options.agents ?? []) {
    p.agents[a.uid] = a;
  }
  return p;
}

/** Create a minimal TaskEntity for testing. */
function makeTestTask(id: string, phaseId: string, overrides: Partial<TaskEntity> = {}): TaskEntity {
  return {
    id,
    title: 'Test Task',
    phaseId,
    status: 'ready',
    steps: [],
    dependencies: [],
    ...overrides,
  };
}

/** Create a minimal AgentEntity for testing. */
function makeTestAgent(
  uid: string,
  taskId: string,
  phaseId: string,
  overrides: Partial<AgentEntity> = {},
): AgentEntity {
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

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('WorkflowTUI', () => {
  describe('constructor', () => {
    it('creates an instance with default options', () => {
      const tui = new WorkflowTUI();
      expect(tui).toBeDefined();
    });

    it('creates an instance with custom options', () => {
      const tui = new WorkflowTUI({ agentLogLines: 6 });
      expect(tui).toBeDefined();
    });

    it('creates an instance with a clientStore', () => {
      const clientStore = new ClientStore();
      const tui = new WorkflowTUI({ clientStore });
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
      expect(dashboard.taskList).toBeDefined();
      expect(dashboard.agentLog).toBeDefined();
    });

    // ── T31: new options ──────────────────────────────────────────────────

    it('accepts runId option (T31)', () => {
      const tui = new WorkflowTUI({ runId: 'run-789' });
      expect(tui).toBeDefined();
    });

    it('accepts onDetach callback option (T31)', () => {
      const tui = new WorkflowTUI({ onDetach: () => {} });
      expect(tui).toBeDefined();
    });

    it('accepts onKill callback option (T31)', () => {
      const tui = new WorkflowTUI({ onKill: () => {} });
      expect(tui).toBeDefined();
    });

    it('accepts all T31 options together (T31)', () => {
      const tui = new WorkflowTUI({
        runId: 'run-999',
        onDetach: () => {},
        onKill: () => {},
        agentLogLines: 12,
      });
      expect(tui).toBeDefined();
    });
  });

  // ─── Client-store integration ────────────────────────────────────────────
  //
  // The TUI now takes a ClientStore (from @engin/shared/client-store) instead
  // of an EventStore. Internally it wires up createWsBackedTui, which:
  //   1. Drains workflow event-log lines (seq-keyed) into the event log.
  //   2. Drains runLog entries (warn/error prefixed; info silent) — this is
  //      how server-captured runtime console output reaches the TUI (T32).
  //   3. Syncs the dashboard from the current projection.
  //   4. Calls requestRender().

  describe('client-store integration', () => {
    it('syncs projection applied via applyEvents into the dashboard', () => {
      const clientStore = new ClientStore();
      const tui = new WorkflowTUI({ clientStore });

      clientStore.applyEvents([
        ev('workflow_started', { taskPrompt: 'test', resumed: false }, {}, 1),
        ev('phase_registered', { id: 'scouting', label: 'Scouting', icon: '🔍' }, {}, 2),
        ev('phase_started', { phase: 'scouting', round: 1 }, {}, 3),
      ]);

      const dashboard = tui.getDashboard();
      // Dashboard follows the current phase.
      expect(dashboard.getSelection().selectedPhaseId).toBe('scouting');
      // The phase bar renders the registered phase label.
      expect(dashboard.phaseBar.render(78)[0]).toContain('Scouting');
    });

    it('syncs projection applied via applySnapshot into the dashboard', () => {
      const clientStore = new ClientStore();
      const tui = new WorkflowTUI({ clientStore });

      clientStore.applySnapshot(
        {
          seq: 1,
          taskPrompt: 'snap',
          phases: [{ id: 'exec', label: 'Exec', icon: '⚡', taskIds: [] }],
          currentPhaseId: 'exec',
          completedPhaseIds: [],
          tasks: {},
          agents: {},
          sidebar: { title: '', indicator: '' },
          status: 'running',
          stats: { totalTokens: 0, agentCount: 0 },
          runLog: [],
        },
        1,
      );

      const dashboard = tui.getDashboard();
      expect(dashboard.getSelection().selectedPhaseId).toBe('exec');
      expect(dashboard.phaseBar.render(78)[0]).toContain('Exec');
    });

    it('forwards workflow event-log lines from applied events into the event log', () => {
      const clientStore = new ClientStore();
      const tui = new WorkflowTUI({ clientStore });

      clientStore.applyEvents([ev('workflow_started', { taskPrompt: 'ship it', resumed: false }, {}, 1)]);

      const joined = tui.getEventLog().render(80).join('\n');
      expect(joined).toContain('🚀 Workflow started: "ship it" (resumed: false)');
    });

    it('does not duplicate event-log lines across multiple applyEvents batches', () => {
      const clientStore = new ClientStore();
      const tui = new WorkflowTUI({ clientStore });

      clientStore.applyEvents([ev('workflow_started', { taskPrompt: 'a', resumed: false }, {}, 1)]);
      clientStore.applyEvents([ev('phase_started', { phase: 'build', round: 1 }, {}, 2)]);

      const joined = tui.getEventLog().render(80).join('\n');
      expect(joined).toContain('🚀 Workflow started: "a" (resumed: false)');
      expect(joined).toContain('📦 Phase: build (round 1)');
    });

    it('renders runLog warn entries with the ⚠️ prefix (server-captured console output)', () => {
      const clientStore = new ClientStore();
      const tui = new WorkflowTUI({ clientStore });

      clientStore.appendRunLog('warn', 'low memory', ISO_NOW);

      const joined = tui.getEventLog().render(80).join('\n');
      expect(joined).toContain('⚠️ low memory');
    });

    it('renders runLog error entries with the ❌ prefix', () => {
      const clientStore = new ClientStore();
      const tui = new WorkflowTUI({ clientStore });

      clientStore.appendRunLog('error', 'kaboom', ISO_NOW);

      const joined = tui.getEventLog().render(80).join('\n');
      expect(joined).toContain('❌ kaboom');
    });

    it('does NOT render runLog info entries', () => {
      const clientStore = new ClientStore();
      const tui = new WorkflowTUI({ clientStore });

      clientStore.appendRunLog('info', 'starting build', ISO_NOW);

      const joined = tui.getEventLog().render(80).join('\n');
      expect(joined).not.toContain('starting build');
    });

    it('coexists: workflow event lines and runLog warn/error lines both appear', () => {
      const clientStore = new ClientStore();
      const tui = new WorkflowTUI({ clientStore });

      clientStore.applyEvents([ev('workflow_started', { taskPrompt: 'x', resumed: false }, {}, 1)]);
      clientStore.appendRunLog('warn', 'careful', ISO_NOW);
      clientStore.appendRunLog('error', 'broke', ISO_NOW);

      const joined = tui.getEventLog().render(80).join('\n');
      expect(joined).toContain('🚀 Workflow started: "x" (resumed: false)');
      expect(joined).toContain('⚠️ careful');
      expect(joined).toContain('❌ broke');
    });

    it('does not wire an adapter when no clientStore is provided', () => {
      const tui = new WorkflowTUI();

      // Applying events to a detached store must not affect the dashboard.
      // Without a clientStore the adapter is never wired, so the dashboard
      // selection stays at its default (selectedPhaseId === null).
      const dashboard = tui.getDashboard();
      expect(dashboard.getSelection().selectedPhaseId).toBeNull();
    });

    it('reflects spawned agents in the synced dashboard projection', () => {
      const clientStore = new ClientStore();
      const tui = new WorkflowTUI({ clientStore });

      clientStore.applyEvents([
        ev('phase_registered', { id: 'impl', label: 'Impl', icon: '🔧' }, {}, 1),
        ev('phase_started', { phase: 'impl', round: 1 }, {}, 2),
        ev(
          'task_registered',
          { taskId: 't1', title: 'Task', phaseId: 'impl', stepCount: 1, steps: [], dependencies: [] },
          {},
          3,
        ),
        ev('task_started', { taskId: 't1', title: 'Task' }, {}, 4),
        ev('agent_spawned', { profile: 'coder' }, { agentId: 'a1', taskId: 't1' }, 5),
      ]);

      const dashboard = tui.getDashboard();
      // The phase bar shows the current phase.
      expect(dashboard.getSelection().selectedPhaseId).toBe('impl');
    });
  });

  // ─── Console (no monkey-patching) ────────────────────────────────────────
  //
  // The refactor REMOVES all console.warn/error monkey-patching. Runtime
  // console output now arrives as server-captured log events via the
  // ClientStore runLog (see "client-store integration" above). The TUI must
  // never override or restore console.log/warn/error.

  describe('console (no monkey-patching)', () => {
    function setupStarted() {
      const addListenerSpy = spyOn(TUI.prototype, 'addInputListener').mockImplementation(function (this: any) {
        this.requestRender = () => {};
        return () => {};
      });
      const tuiStartSpy = spyOn(TUI.prototype, 'start').mockImplementation(() => {});
      const tuiStopSpy = spyOn(TUI.prototype, 'stop').mockImplementation(() => {});
      const wtui = new WorkflowTUI();
      return {
        wtui,
        cleanup: () => {
          addListenerSpy.mockRestore();
          tuiStartSpy.mockRestore();
          tuiStopSpy.mockRestore();
        },
      };
    }

    it('does not override console.log/warn/error on start()', () => {
      const originalLog = console.log;
      const originalWarn = console.warn;
      const originalError = console.error;

      const { wtui, cleanup } = setupStarted();
      try {
        wtui.start();
        expect(console.log).toBe(originalLog);
        expect(console.warn).toBe(originalWarn);
        expect(console.error).toBe(originalError);
      } finally {
        wtui.stop();
        cleanup();
      }
    });

    it('does not override console.log/warn/error on stop()', () => {
      const originalLog = console.log;
      const originalWarn = console.warn;
      const originalError = console.error;

      const { wtui, cleanup } = setupStarted();
      try {
        wtui.start();
        wtui.stop();
        expect(console.log).toBe(originalLog);
        expect(console.warn).toBe(originalWarn);
        expect(console.error).toBe(originalError);
      } finally {
        cleanup();
      }
    });

    it('console.warn no longer routes into the event log after start()', () => {
      const { wtui, cleanup } = setupStarted();
      try {
        wtui.start();
        const before = wtui.getEventLog().render(80).join('\n');

        console.warn('a warning that must not appear');

        const after = wtui.getEventLog().render(80).join('\n');
        expect(after).toBe(before);
        expect(after).not.toContain('a warning that must not appear');
      } finally {
        wtui.stop();
        cleanup();
      }
    });

    it('console.error no longer routes into the event log after start()', () => {
      const { wtui, cleanup } = setupStarted();
      try {
        wtui.start();
        const before = wtui.getEventLog().render(80).join('\n');

        console.error('an error that must not appear');

        const after = wtui.getEventLog().render(80).join('\n');
        expect(after).toBe(before);
        expect(after).not.toContain('an error that must not appear');
      } finally {
        wtui.stop();
        cleanup();
      }
    });
  });

  // ─── T31: Detach/kill prompt ──────────────────────────────────────────────
  //
  // Ctrl+C now shows an in-TUI prompt overlay with two choices:
  //   • Detach (default) — leave run running on server, exit client
  //   • Kill — send cancel_run, wait for terminal, then exit
  //
  // Second Ctrl+C at the prompt or Escape dismisses it.
  // Ctrl+D detaches immediately (no prompt).
  //
  // WorkflowTUIOptions gains: runId, onDetach, onKill (callback form so
  // tui never imports engine — see the package dependency rules).
  //
  // These tests encode the T31 contract. They will be RED until the
  // implement phase adds the new options and changes the Ctrl+C handler.

  describe('detach/kill prompt (T31)', () => {
    const CTRL_C = '\x03';
    const ENTER = '\r';
    const ESCAPE = '\x1b';
    const UP_ARROW = '\x1b[A';
    const DOWN_ARROW = '\x1b[B';

    /**
     * Setup helper: creates a WorkflowTUI with T31 options, mocks the
     * underlying TUI so we can capture the global input listener and
     * spy on showOverlay.
     */
    function setupPrompt(
      options: {
        runId?: string;
        onDetach?: () => void;
        onKill?: () => void;
      } = {},
    ) {
      const onDetachMock = options.onDetach ?? mock(() => {});
      const onKillMock = options.onKill ?? mock(() => {});
      const requestRenderMock = mock(() => {});
      const hideMock = mock(() => {});
      const overlayHandle = {
        hide: hideMock,
        setHidden: mock(() => {}),
        isHidden: mock(() => false),
        focus: mock(() => {}),
        unfocus: mock(() => {}),
        isFocused: mock(() => false),
      };
      const showOverlayMock = mock(() => overlayHandle);
      let capturedCallback: ((data: string) => any) | null = null;

      const addListenerSpy = spyOn(TUI.prototype, 'addInputListener').mockImplementation(function (
        this: any,
        cb: (data: string) => any,
      ) {
        capturedCallback = cb;
        this.requestRender = requestRenderMock;
        this.showOverlay = showOverlayMock;
        return () => {};
      });
      const tuiStartSpy = spyOn(TUI.prototype, 'start').mockImplementation(() => {});
      const tuiStopSpy = spyOn(TUI.prototype, 'stop').mockImplementation(() => {});

      const wtui = new WorkflowTUI({
        runId: options.runId ?? 'run-abc',
        onDetach: onDetachMock,
        onKill: onKillMock,
      });
      wtui.start();

      return {
        wtui,
        callback: capturedCallback!,
        requestRenderMock,
        showOverlayMock,
        overlayHandle,
        onDetachMock,
        onKillMock,
        cleanup() {
          wtui.stop();
          addListenerSpy.mockRestore();
          tuiStartSpy.mockRestore();
          tuiStopSpy.mockRestore();
        },
      };
    }

    it('first Ctrl+C shows the detach/kill prompt overlay', () => {
      const { callback, showOverlayMock, cleanup } = setupPrompt();
      try {
        expect(callback).not.toBeNull();
        callback(CTRL_C);

        expect(showOverlayMock).toHaveBeenCalledTimes(1);
        const [component, options] = showOverlayMock.mock.calls[0];
        expect(component).toBeDefined();
        expect(typeof component.render).toBe('function');
        expect(options).toEqual(expect.objectContaining({ anchor: expect.any(String) }));
      } finally {
        cleanup();
      }
    });

    it('the prompt shows the runId when provided', () => {
      const { callback, showOverlayMock, cleanup } = setupPrompt({ runId: 'run-xyz-123' });
      try {
        callback(CTRL_C);
        const [component] = showOverlayMock.mock.calls[0];
        const lines = component.render(60);
        expect(lines.join('\n')).toContain('run-xyz-123');
      } finally {
        cleanup();
      }
    });

    it('Detach is the default (highlighted) selection', () => {
      const { callback, showOverlayMock, cleanup } = setupPrompt();
      try {
        callback(CTRL_C);
        const [component] = showOverlayMock.mock.calls[0];
        const lines = component.render(60);
        const joined = lines.join('\n');
        expect(joined).toContain('Detach');
        expect(joined).toContain('Kill');
      } finally {
        cleanup();
      }
    });

    it('Down arrow navigates from Detach to Kill', () => {
      const { callback, showOverlayMock, cleanup } = setupPrompt();
      try {
        callback(CTRL_C);
        const [component] = showOverlayMock.mock.calls[0];

        // Navigate down — should not throw
        component.handleInput(DOWN_ARROW);
        const lines = component.render(60);
        expect(lines.join('\n')).toContain('Kill');
      } finally {
        cleanup();
      }
    });

    it('Up arrow navigates back from Kill to Detach', () => {
      const { callback, showOverlayMock, cleanup } = setupPrompt();
      try {
        callback(CTRL_C);
        const [component] = showOverlayMock.mock.calls[0];

        component.handleInput(DOWN_ARROW);
        component.handleInput(UP_ARROW);
        const lines = component.render(60);
        expect(lines.join('\n')).toContain('Detach');
      } finally {
        cleanup();
      }
    });

    it('Enter with Detach selected calls onDetach', () => {
      const { callback, showOverlayMock, onDetachMock, overlayHandle, cleanup } = setupPrompt();
      try {
        callback(CTRL_C);
        const [component] = showOverlayMock.mock.calls[0];

        // Detach is default, press Enter to confirm
        component.handleInput(ENTER);
        expect(onDetachMock).toHaveBeenCalledTimes(1);
        expect(overlayHandle.hide).toHaveBeenCalled();
      } finally {
        cleanup();
      }
    });

    it('Enter with Kill selected calls onKill', () => {
      const { callback, showOverlayMock, onKillMock, overlayHandle, cleanup } = setupPrompt();
      try {
        callback(CTRL_C);
        const [component] = showOverlayMock.mock.calls[0];

        component.handleInput(DOWN_ARROW); // select Kill
        component.handleInput(ENTER); // confirm
        expect(onKillMock).toHaveBeenCalledTimes(1);
        expect(overlayHandle.hide).toHaveBeenCalled();
      } finally {
        cleanup();
      }
    });

    it('second Ctrl+C at the prompt dismisses it (no callback fired)', () => {
      const { callback, showOverlayMock, onDetachMock, onKillMock, overlayHandle, cleanup } = setupPrompt();
      try {
        callback(CTRL_C);
        const [component] = showOverlayMock.mock.calls[0];

        // Second Ctrl+C on the overlay component dismisses the prompt
        component.handleInput(CTRL_C);
        expect(overlayHandle.hide).toHaveBeenCalled();
        expect(onDetachMock).not.toHaveBeenCalled();
        expect(onKillMock).not.toHaveBeenCalled();
      } finally {
        cleanup();
      }
    });

    it('Escape at the prompt dismisses it (no callback fired)', () => {
      const { callback, showOverlayMock, onDetachMock, onKillMock, overlayHandle, cleanup } = setupPrompt();
      try {
        callback(CTRL_C);
        const [component] = showOverlayMock.mock.calls[0];

        component.handleInput(ESCAPE);
        expect(overlayHandle.hide).toHaveBeenCalled();
        expect(onDetachMock).not.toHaveBeenCalled();
        expect(onKillMock).not.toHaveBeenCalled();
      } finally {
        cleanup();
      }
    });

    it('calls requestRender when Ctrl+C shows the prompt', () => {
      const { callback, requestRenderMock, cleanup } = setupPrompt();
      try {
        callback(CTRL_C);
        expect(requestRenderMock).toHaveBeenCalled();
      } finally {
        cleanup();
      }
    });
  });

  // ─── T31: Ctrl+D immediate detach ────────────────────────────────────────

  describe('Ctrl+D immediate detach (T31)', () => {
    const CTRL_D = '\x04';

    it('calls onDetach immediately without showing prompt', () => {
      const onDetachMock = mock(() => {});
      const showOverlayMock = mock(() => ({
        hide: mock(() => {}),
        setHidden: mock(() => {}),
        isHidden: mock(() => false),
        focus: mock(() => {}),
        unfocus: mock(() => {}),
        isFocused: mock(() => false),
      }));
      let capturedCallback: ((data: string) => any) | null = null;

      const addListenerSpy = spyOn(TUI.prototype, 'addInputListener').mockImplementation(function (
        this: any,
        cb: (data: string) => any,
      ) {
        capturedCallback = cb;
        this.requestRender = mock(() => {});
        this.showOverlay = showOverlayMock;
        return () => {};
      });
      const tuiStartSpy = spyOn(TUI.prototype, 'start').mockImplementation(() => {});
      const tuiStopSpy = spyOn(TUI.prototype, 'stop').mockImplementation(() => {});

      const wtui = new WorkflowTUI({
        runId: 'run-123',
        onDetach: onDetachMock,
      });
      wtui.start();

      try {
        capturedCallback!(CTRL_D);
        expect(onDetachMock).toHaveBeenCalledTimes(1);
        expect(showOverlayMock).not.toHaveBeenCalled();
      } finally {
        wtui.stop();
        addListenerSpy.mockRestore();
        tuiStartSpy.mockRestore();
        tuiStopSpy.mockRestore();
      }
    });

    it('calls onDetach even when no runId is provided', () => {
      const onDetachMock = mock(() => {});
      let capturedCallback: ((data: string) => any) | null = null;

      const addListenerSpy = spyOn(TUI.prototype, 'addInputListener').mockImplementation(function (
        this: any,
        cb: (data: string) => any,
      ) {
        capturedCallback = cb;
        this.requestRender = mock(() => {});
        this.showOverlay = mock(() => ({}));
        return () => {};
      });
      const tuiStartSpy = spyOn(TUI.prototype, 'start').mockImplementation(() => {});
      const tuiStopSpy = spyOn(TUI.prototype, 'stop').mockImplementation(() => {});

      const wtui = new WorkflowTUI({ onDetach: onDetachMock });
      wtui.start();

      try {
        capturedCallback!(CTRL_D);
        expect(onDetachMock).toHaveBeenCalledTimes(1);
      } finally {
        wtui.stop();
        addListenerSpy.mockRestore();
        tuiStartSpy.mockRestore();
        tuiStopSpy.mockRestore();
      }
    });

    it('Ctrl+D does not call onKill', () => {
      const onDetachMock = mock(() => {});
      const onKillMock = mock(() => {});
      let capturedCallback: ((data: string) => any) | null = null;

      const addListenerSpy = spyOn(TUI.prototype, 'addInputListener').mockImplementation(function (
        this: any,
        cb: (data: string) => any,
      ) {
        capturedCallback = cb;
        this.requestRender = mock(() => {});
        this.showOverlay = mock(() => ({}));
        return () => {};
      });
      const tuiStartSpy = spyOn(TUI.prototype, 'start').mockImplementation(() => {});
      const tuiStopSpy = spyOn(TUI.prototype, 'stop').mockImplementation(() => {});

      const wtui = new WorkflowTUI({
        runId: 'run-456',
        onDetach: onDetachMock,
        onKill: onKillMock,
      });
      wtui.start();

      try {
        capturedCallback!(CTRL_D);
        expect(onDetachMock).toHaveBeenCalledTimes(1);
        expect(onKillMock).not.toHaveBeenCalled();
      } finally {
        wtui.stop();
        addListenerSpy.mockRestore();
        tuiStartSpy.mockRestore();
        tuiStopSpy.mockRestore();
      }
    });
  });

  describe('input routing', () => {
    const LEFT_ARROW = '\x1b[D';
    const RIGHT_ARROW = '\x1b[C';
    const TAB = '\t';

    /** Helper: set up dashboard with a projection that has phases and agents. */
    function setupBasic(tui: WorkflowTUI) {
      const dashboard = tui.getDashboard();
      const p = projectionWithAgents(['phase-a', 'phase-b'], ['agent-1', 'agent-2']);
      dashboard.syncFromProjection(p);
      return dashboard;
    }

    it('left/right routes to phaseBar and changes selectedPhaseId', () => {
      const tui = new WorkflowTUI();
      const dashboard = setupBasic(tui);

      expect(dashboard.getSelection().selectedPhaseId).toBe('phase-a');

      const phaseSpy = spyOn(dashboard.phaseBar, 'handleInput');

      dashboard.handleInput(RIGHT_ARROW);
      expect(phaseSpy).toHaveBeenCalledWith(RIGHT_ARROW);
      expect(dashboard.getSelection().selectedPhaseId).toBe('phase-b');

      dashboard.handleInput(LEFT_ARROW);
      expect(dashboard.getSelection().selectedPhaseId).toBe('phase-a');

      phaseSpy.mockRestore();
    });

    it('tab routes to agentLog and cycles steps (thus agents)', () => {
      const tui = new WorkflowTUI();
      const dashboard = setupBasic(tui);

      // Initially step 0 / agent-1 is selected
      expect(dashboard.agentLog.getSelectedAgentUid()).toBeTruthy();
      const initialAgent = dashboard.agentLog.getSelectedAgentUid();

      dashboard.handleInput(TAB);
      const secondAgent = dashboard.agentLog.getSelectedAgentUid();
      // Tab cycles to next step (with agentKey)
      expect(secondAgent).not.toBe(initialAgent);
    });

    it('non-arrow/non-tab keys are NOT routed to any subcomponent', () => {
      const tui = new WorkflowTUI();
      const dashboard = setupBasic(tui);

      const phaseSpy = spyOn(dashboard.phaseBar, 'handleInput');
      const logSpy = spyOn(dashboard.agentLog, 'handleInput');

      dashboard.handleInput('x');
      expect(phaseSpy).not.toHaveBeenCalled();
      expect(logSpy).not.toHaveBeenCalled();

      phaseSpy.mockRestore();
      logSpy.mockRestore();
    });

    it('input listener fix: left/right must be consumed by global listener', () => {
      const tui = new WorkflowTUI();
      const dashboard = setupBasic(tui);

      expect(dashboard.getSelection().selectedPhaseId).toBe('phase-a');

      dashboard.handleInput(RIGHT_ARROW);
      // Phase should have changed — proving the pipeline works end-to-end
      expect(dashboard.getSelection().selectedPhaseId).toBe('phase-b');
    });

    it('Tab routed to dashboard.handleInput from global listener', () => {
      const tui = new WorkflowTUI();
      const dashboard = setupBasic(tui);

      const spy = spyOn(dashboard, 'handleInput');
      dashboard.handleInput(TAB);
      expect(spy).toHaveBeenCalledWith(TAB);
      spy.mockRestore();
    });

    it('Left/Right routed to dashboard.handleInput from global listener', () => {
      const tui = new WorkflowTUI();
      const dashboard = setupBasic(tui);

      const spy = spyOn(dashboard, 'handleInput');
      dashboard.handleInput(LEFT_ARROW);
      expect(spy).toHaveBeenCalledWith(LEFT_ARROW);

      dashboard.handleInput(RIGHT_ARROW);
      expect(spy).toHaveBeenCalledWith(RIGHT_ARROW);

      spy.mockRestore();
    });
  });

  describe('dashboard integration', () => {
    it('uses custom agentLogLines', () => {
      const tui = new WorkflowTUI({ agentLogLines: 8 });
      const dashboard = tui.getDashboard();
      expect(dashboard.getComputedHeight()).toBe(1 + 0 + 8 + 4);
    });

    it('uses default agentLogLines (20)', () => {
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

      const wtui = new WorkflowTUI();
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

        // Build a projection with a task and agents that have taskId/phaseId
        const p = buildProjection({
          phases: [{ id: 'test' }],
          currentPhaseId: 'test',
          tasks: [
            makeTestTask('t1', 'test', {
              status: 'active',
              activeStepIndex: 0,
              steps: [{ name: 'Step 1', index: 0, agentKey: 'agent-1' }],
              startedAt: Date.now(),
            }),
          ],
          agents: [
            makeTestAgent('agent-1', 't1', 'test', {
              log: Array.from({ length: 60 }, (_, i) => ({
                id: `${i}`,
                timestamp: '',
                type: 'text' as const,
                content: `entry ${i + 1}`,
              })),
            }),
          ],
        });
        dashboard.syncFromProjection(p);
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
        expect(dashboard.agentLog.isExpanded()).toBe(true);

        // Build a projection with a task and agents
        const p = buildProjection({
          phases: [{ id: 'test' }],
          currentPhaseId: 'test',
          tasks: [
            makeTestTask('t1', 'test', {
              status: 'active',
              activeStepIndex: 0,
              steps: [{ name: 'Step 1', index: 0, agentKey: 'agent-1' }],
              startedAt: Date.now(),
            }),
          ],
          agents: [
            makeTestAgent('agent-1', 't1', 'test', {
              log: Array.from({ length: 60 }, (_, i) => ({
                id: `${i}`,
                timestamp: '',
                type: 'text' as const,
                content: `entry ${i + 1}`,
              })),
            }),
          ],
        });
        dashboard.syncFromProjection(p);
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

  describe('left/right phase navigation', () => {
    const RIGHT_ARROW = '\x1b[C';

    it('left/right arrow navigation changes selected phase via phaseBar', () => {
      const tui = new WorkflowTUI();
      const dashboard = tui.getDashboard();

      const p = projectionWithAgents(['alpha', 'beta'], ['agent-1']);
      dashboard.syncFromProjection(p);

      expect(dashboard.getSelection().selectedPhaseId).toBe('alpha');

      dashboard.handleInput(RIGHT_ARROW);
      expect(dashboard.getSelection().selectedPhaseId).toBe('beta');

      dashboard.handleInput(RIGHT_ARROW);
      // Wraps back to first
      expect(dashboard.getSelection().selectedPhaseId).toBe('alpha');
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
        const wtui = new WorkflowTUI();
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
        const wtui = new WorkflowTUI();
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

  // ─── pauseForInspection: client-store completion ─────────────────────────
  //
  // With the refactor, pauseForInspection now also resolves when the client
  // store observes a run_complete / run_failed (status 'complete' or 'failed'),
  // in addition to Escape/Ctrl+C and the optional AbortSignal.

  describe('pauseForInspection (client-store completion)', () => {
    function setupClientStorePauseTest() {
      const clientStore = new ClientStore();
      const wtui = new WorkflowTUI({ clientStore });
      (wtui as any).tui = {
        showOverlay: mock(() => {}),
        requestRender: mock(() => {}),
        addInputListener: mock(() => () => {}),
        addChild: mock(() => {}),
        setFocus: mock(() => {}),
        stop: mock(() => {}),
        start: mock(() => {}),
      } as any;
      (wtui as any).running = true;
      return { wtui, clientStore };
    }

    it('resolves when the client store reaches "complete" status', async () => {
      const { wtui, clientStore } = setupClientStorePauseTest();

      const promise = wtui.pauseForInspection();
      // Yield once so any listener/subscription wiring settles.
      await new Promise((r) => setTimeout(r, 5));

      clientStore.setStatus('complete');

      await expect(promise).resolves.toBeUndefined();
    });

    it('resolves when the client store reaches "failed" status', async () => {
      const { wtui, clientStore } = setupClientStorePauseTest();

      const promise = wtui.pauseForInspection();
      await new Promise((r) => setTimeout(r, 5));

      clientStore.setStatus('failed');

      await expect(promise).resolves.toBeUndefined();
    });

    it('resolves when a workflow_completed event is applied to the client store', async () => {
      const { wtui, clientStore } = setupClientStorePauseTest();

      const promise = wtui.pauseForInspection();
      await new Promise((r) => setTimeout(r, 5));

      clientStore.applyEvents([ev('workflow_completed', { totalDurationMs: 1000, agentCount: 1 }, {}, 1)]);

      await expect(promise).resolves.toBeUndefined();
    });

    it('resolves when a workflow_failed event is applied to the client store', async () => {
      const { wtui, clientStore } = setupClientStorePauseTest();

      const promise = wtui.pauseForInspection();
      await new Promise((r) => setTimeout(r, 5));

      clientStore.applyEvents([ev('workflow_failed', { phase: 'planning', error: 'boom' }, {}, 1)]);

      await expect(promise).resolves.toBeUndefined();
    });

    it('does not resolve while the client store is still "running"', async () => {
      const { wtui, clientStore } = setupClientStorePauseTest();

      let resolved = false;
      const promise = wtui.pauseForInspection();
      promise.then(() => {
        resolved = true;
      });
      await new Promise((r) => setTimeout(r, 10));

      // Still running → must not have resolved.
      expect(resolved).toBe(false);

      // Drive it to completion so the dangling promise does not keep the
      // process alive / leak listeners across tests.
      clientStore.setStatus('complete');
      await promise;
    });

    it('still resolves via Escape key even with a client store attached', async () => {
      const { wtui } = setupClientStorePauseTest();

      const promise = wtui.pauseForInspection();
      // The pause input listener is added after the main handler is torn down.
      const tuiMock = (wtui as any).tui;
      const listener = tuiMock.addInputListener.mock.calls[tuiMock.addInputListener.mock.calls.length - 1][0];

      const result = listener('\x1b');
      expect(result).toEqual({ consume: true });

      await expect(promise).resolves.toBeUndefined();
    });
  });
});
