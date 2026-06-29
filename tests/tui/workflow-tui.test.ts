import { TUI } from '@earendil-works/pi-tui';
import type { SessionEntity, TaskEntity, WorkflowProjection } from '@engin/shared';
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

/** Create a minimal projection with sessions in given phases. */
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
        dependencies: [],
        startedAt: Date.now(),
      },
    },
    sessions: {},
    sidebar: { title: '', indicator: '' },
    status: 'running',
    stats: { totalTokens: 0, sessionCount: 0 },
    runLog: [],
  };
  for (const phase of phases) {
    for (const agentId of agentIds) {
      const key = agentId + '-' + phase;
      p.sessions[key] = {
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
        runnerRole: 'executor',
        attempt: 1,
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
  sessions?: SessionEntity[];
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
    sessions: {} as Record<string, SessionEntity>,
    sidebar: { title: '', indicator: options.indicator ?? '' },
    status: 'running' as const,
    stats: { totalTokens: 0, sessionCount: 0 },
    runLog: [] as WorkflowProjection['runLog'],
  };
  for (const t of options.tasks ?? []) {
    p.tasks[t.id] = t;
  }
  for (const a of options.sessions ?? []) {
    p.sessions[a.uid] = a;
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

    dependencies: [],
    ...overrides,
  };
}

/** Create a minimal SessionEntity for testing. */
function makeTestAgent(
  uid: string,
  taskId: string,
  phaseId: string,
  overrides: Partial<SessionEntity> = {},
): SessionEntity {
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
    runnerRole: 'executor',
    attempt: 1,
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
          sessions: {},
          sidebar: { title: '', indicator: '' },
          status: 'running',
          stats: { totalTokens: 0, sessionCount: 0 },
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
      expect(joined).toContain('🚀 workflow started: "ship it" (resumed: false)');
    });

    it('does not duplicate event-log lines across multiple applyEvents batches', () => {
      const clientStore = new ClientStore();
      const tui = new WorkflowTUI({ clientStore });

      clientStore.applyEvents([ev('workflow_started', { taskPrompt: 'a', resumed: false }, {}, 1)]);
      clientStore.applyEvents([ev('phase_started', { phase: 'build', round: 1 }, {}, 2)]);

      const joined = tui.getEventLog().render(80).join('\n');
      expect(joined).toContain('🚀 workflow started: "a" (resumed: false)');
      expect(joined).toContain('📦 phase started (round 1)');
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
      expect(joined).toContain('🚀 workflow started: "x" (resumed: false)');
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

    it('reflects spawned sessions in the synced dashboard projection', () => {
      const clientStore = new ClientStore();
      const tui = new WorkflowTUI({ clientStore });

      clientStore.applyEvents([
        ev('phase_registered', { id: 'impl', label: 'Impl', icon: '🔧' }, {}, 1),
        ev('phase_started', { phase: 'impl', round: 1 }, {}, 2),
        ev('task_registered', { taskId: 't1', title: 'Task', phaseId: 'impl', stepCount: 1, dependencies: [] }, {}, 3),
        ev('task_started', { taskId: 't1', title: 'Task' }, {}, 4),
        ev('session_started', { profile: 'coder' }, { agentId: 'a1', taskId: 't1' }, 5),
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
      const showOverlayMock = mock(
        (
          _component: { render: (w: number) => string[]; handleInput: (d: string) => void },
          _options: Record<string, unknown>,
        ) => overlayHandle,
      );
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

    /** Helper: set up dashboard with a projection that has phases and sessions. */
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

    it('tab routes to agentLog and cycles steps (thus sessions)', () => {
      const tui = new WorkflowTUI();
      const dashboard = setupBasic(tui);

      // Initially step 0 / agent-1 is selected
      expect(dashboard.agentLog.getSelectedSessionId()).toBeTruthy();
      const initialSession = dashboard.agentLog.getSelectedSessionId();

      dashboard.handleInput(TAB);
      const secondSession = dashboard.agentLog.getSelectedSessionId();
      // Tab cycles to next step (with agentKey)
      expect(secondSession).not.toBe(initialSession);
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
        callback: capturedCallback!,
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
      const { callback, requestRenderMock, cleanup } = setupTest();
      try {
        callback(TAB);
        expect(requestRenderMock).toHaveBeenCalled();
      } finally {
        cleanup();
      }
    });

    it('calls requestRender when Left arrow key is handled', () => {
      const { callback, requestRenderMock, cleanup } = setupTest();
      try {
        callback(LEFT_ARROW);
        expect(requestRenderMock).toHaveBeenCalled();
      } finally {
        cleanup();
      }
    });

    it('calls requestRender when Right arrow key is handled', () => {
      const { callback, requestRenderMock, cleanup } = setupTest();
      try {
        callback(RIGHT_ARROW);
        expect(requestRenderMock).toHaveBeenCalled();
      } finally {
        cleanup();
      }
    });

    it('calls requestRender when Ctrl+C is handled (regression)', () => {
      const { callback, requestRenderMock, cleanup } = setupTest();
      try {
        callback(CTRL_C);
        expect(requestRenderMock).toHaveBeenCalled();
      } finally {
        cleanup();
      }
    });

    it('calls requestRender when Space key toggles expand', () => {
      const { callback, requestRenderMock, cleanup } = setupTest();
      try {
        callback(SPACE);
        expect(requestRenderMock).toHaveBeenCalled();
      } finally {
        cleanup();
      }
    });

    it('consumes Up arrow and calls requestRender when agent log is expanded', () => {
      const { callback, requestRenderMock, wtui, cleanup } = setupTest();
      try {
        const dashboard = wtui.getDashboard();
        dashboard.agentLog.toggleExpand();
        expect(dashboard.agentLog.isExpanded()).toBe(true);

        const result = callback(UP_ARROW);
        expect(result).toEqual({ consume: true });
        expect(requestRenderMock).toHaveBeenCalled();
      } finally {
        cleanup();
      }
    });

    it('consumes Down arrow and calls requestRender when agent log is expanded', () => {
      const { callback, requestRenderMock, wtui, cleanup } = setupTest();
      try {
        const dashboard = wtui.getDashboard();
        dashboard.agentLog.toggleExpand();
        expect(dashboard.agentLog.isExpanded()).toBe(true);

        const result = callback(DOWN_ARROW);
        expect(result).toEqual({ consume: true });
        expect(requestRenderMock).toHaveBeenCalled();
      } finally {
        cleanup();
      }
    });

    it('consumes Up arrow even when agent log is NOT expanded', () => {
      const { callback, requestRenderMock, cleanup } = setupTest();
      try {
        const result = callback(UP_ARROW);
        expect(result).toEqual({ consume: true });
        expect(requestRenderMock).toHaveBeenCalled();
      } finally {
        cleanup();
      }
    });

    it('consumes Down arrow even when agent log is NOT expanded', () => {
      const { callback, requestRenderMock, cleanup } = setupTest();
      try {
        const result = callback(DOWN_ARROW);
        expect(result).toEqual({ consume: true });
        expect(requestRenderMock).toHaveBeenCalled();
      } finally {
        cleanup();
      }
    });

    it('existing Left/Right handler still works after adding new handlers', () => {
      const { callback, requestRenderMock, cleanup } = setupTest();
      try {
        const leftResult = callback(LEFT_ARROW);
        expect(leftResult).toEqual({ consume: true });
        expect(requestRenderMock).toHaveBeenCalled();

        requestRenderMock.mockClear();
        const rightResult = callback(RIGHT_ARROW);
        expect(rightResult).toEqual({ consume: true });
        expect(requestRenderMock).toHaveBeenCalled();
      } finally {
        cleanup();
      }
    });

    it('existing Tab handler still works after adding new handlers', () => {
      const { callback, requestRenderMock, cleanup } = setupTest();
      try {
        const result = callback(TAB);
        expect(result).toEqual({ consume: true });
        expect(requestRenderMock).toHaveBeenCalled();
      } finally {
        cleanup();
      }
    });

    it('existing Ctrl+C handler still works after adding new handlers', () => {
      const { callback, requestRenderMock, cleanup } = setupTest();
      try {
        const result = callback(CTRL_C);
        expect(result).toEqual({ consume: true });
        expect(requestRenderMock).toHaveBeenCalled();
      } finally {
        cleanup();
      }
    });

    // ─── Scroll key routing (PgUp/PgDn/Home/End) ───────────────────────

    it('routes pageUp key to eventLog.handleInput and consumes it', () => {
      const { callback, requestRenderMock, wtui, cleanup } = setupTest();
      try {
        for (let i = 1; i <= 10; i++) {
          wtui.getEventLog().addLine(`line ${i}`);
        }
        expect(wtui.getEventLog().isScrolledUp).toBe(false);

        const result = callback('\x1b[5~');
        expect(result).toEqual({ consume: true });
        expect(requestRenderMock).toHaveBeenCalled();
        expect(wtui.getEventLog().isScrolledUp).toBe(true);
      } finally {
        cleanup();
      }
    });

    it('routes pageDown key to eventLog.handleInput and consumes it', () => {
      const { callback, requestRenderMock, wtui, cleanup } = setupTest();
      try {
        for (let i = 1; i <= 10; i++) {
          wtui.getEventLog().addLine(`line ${i}`);
        }
        callback('\x1b[5~');
        expect(wtui.getEventLog().isScrolledUp).toBe(true);
        requestRenderMock.mockClear();

        const result = callback('\x1b[6~');
        expect(result).toEqual({ consume: true });
        expect(requestRenderMock).toHaveBeenCalled();
      } finally {
        cleanup();
      }
    });

    it('routes home key to eventLog.handleInput and consumes it', () => {
      const { callback, requestRenderMock, wtui, cleanup } = setupTest();
      try {
        for (let i = 1; i <= 10; i++) {
          wtui.getEventLog().addLine(`line ${i}`);
        }
        expect(wtui.getEventLog().isScrolledUp).toBe(false);

        const result = callback('\x1b[H');
        expect(result).toEqual({ consume: true });
        expect(requestRenderMock).toHaveBeenCalled();
        expect(wtui.getEventLog().isScrolledUp).toBe(true);
      } finally {
        cleanup();
      }
    });

    it('routes end key to eventLog.handleInput and consumes it', () => {
      const { callback, requestRenderMock, wtui, cleanup } = setupTest();
      try {
        for (let i = 1; i <= 10; i++) {
          wtui.getEventLog().addLine(`line ${i}`);
        }
        callback('\x1b[5~');
        expect(wtui.getEventLog().isScrolledUp).toBe(true);
        requestRenderMock.mockClear();

        const result = callback('\x1b[F');
        expect(result).toEqual({ consume: true });
        expect(requestRenderMock).toHaveBeenCalled();
        expect(wtui.getEventLog().isScrolledUp).toBe(false);
      } finally {
        cleanup();
      }
    });

    it('routes pageDown to bottom enables autoScroll on eventLog', () => {
      const { callback, wtui, cleanup } = setupTest();
      try {
        for (let i = 1; i <= 10; i++) {
          wtui.getEventLog().addLine(`line ${i}`);
        }
        callback('\x1b[5~');
        expect(wtui.getEventLog().isScrolledUp).toBe(true);
        callback('\x1b[6~');

        wtui.getEventLog().addLine('bottom line');
        expect(wtui.getEventLog().isScrolledUp).toBe(false);
      } finally {
        cleanup();
      }
    });

    it('scroll keys do not interfere with other key handlers', () => {
      const { callback, requestRenderMock, cleanup } = setupTest();
      try {
        let result = callback('\t');
        expect(result).toEqual({ consume: true });

        requestRenderMock.mockClear();
        result = callback('\x1b[D');
        expect(result).toEqual({ consume: true });

        requestRenderMock.mockClear();
        result = callback('\x1b[C');
        expect(result).toEqual({ consume: true });

        requestRenderMock.mockClear();
        result = callback('\x1b[5~');
        expect(result).toEqual({ consume: true });

        requestRenderMock.mockClear();
        result = callback('\x1b[6~');
        expect(result).toEqual({ consume: true });

        requestRenderMock.mockClear();
        result = callback('\x1b[H');
        expect(result).toEqual({ consume: true });

        requestRenderMock.mockClear();
        result = callback('\x1b[F');
        expect(result).toEqual({ consume: true });
      } finally {
        cleanup();
      }
    });

    it('requests render for each scroll key', () => {
      const { callback, requestRenderMock, cleanup } = setupTest();
      try {
        const scrollKeys = ['\x1b[5~', '\x1b[6~', '\x1b[H', '\x1b[F'];
        for (const key of scrollKeys) {
          requestRenderMock.mockClear();
          callback(key);
          expect(requestRenderMock).toHaveBeenCalled();
        }
      } finally {
        cleanup();
      }
    });

    it('scroll keys set autoscroll to false when scrolling up', () => {
      const { callback, wtui, cleanup } = setupTest();
      try {
        for (let i = 1; i <= 10; i++) {
          wtui.getEventLog().addLine(`line ${i}`);
        }
        callback('\x1b[5~');
        wtui.getEventLog().addLine('new line');
        expect(wtui.getEventLog().isScrolledUp).toBe(true);
      } finally {
        cleanup();
      }
    });

    // ─── Shift+Up/Shift+Down scroll by 10 ───────────────────────────

    it('shift+up scrolls by 10 when expanded', () => {
      const { callback, requestRenderMock, wtui, cleanup } = setupTest();
      try {
        const dashboard = wtui.getDashboard();

        dashboard.agentLog.toggleExpand();
        expect(dashboard.agentLog.isExpanded()).toBe(true);

        // Build a projection with a task and sessions that have taskId/phaseId
        const p = buildProjection({
          phases: [{ id: 'test' }],
          currentPhaseId: 'test',
          tasks: [
            makeTestTask('t1', 'test', {
              status: 'active',

              startedAt: Date.now(),
            }),
          ],
          sessions: [
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
          callback(SHIFT_UP);
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
      const { callback, requestRenderMock, wtui, cleanup } = setupTest();
      try {
        const dashboard = wtui.getDashboard();

        dashboard.agentLog.toggleExpand();
        expect(dashboard.agentLog.isExpanded()).toBe(true);

        // Build a projection with a task and sessions
        const p = buildProjection({
          phases: [{ id: 'test' }],
          currentPhaseId: 'test',
          tasks: [
            makeTestTask('t1', 'test', {
              status: 'active',

              startedAt: Date.now(),
            }),
          ],
          sessions: [
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
          callback(SHIFT_UP);
        }
        requestRenderMock.mockClear();

        callback(SHIFT_DOWN);

        const lines = dashboard.agentLog.render(80);
        const joined = lines.join('\n');
        expect(joined).toMatch(/up arrow \d+ more/);
        expect(requestRenderMock).toHaveBeenCalled();
      } finally {
        cleanup();
      }
    });

    it('shift+up falls through when NOT expanded', () => {
      const { callback, requestRenderMock, wtui, cleanup } = setupTest();
      try {
        expect(wtui.getDashboard().agentLog.isExpanded()).toBe(false);

        const result = callback(SHIFT_UP);
        expect(result).toBeUndefined();
        expect(requestRenderMock).not.toHaveBeenCalled();
      } finally {
        cleanup();
      }
    });

    it('shift+down falls through when NOT expanded', () => {
      const { callback, requestRenderMock, wtui, cleanup } = setupTest();
      try {
        expect(wtui.getDashboard().agentLog.isExpanded()).toBe(false);

        const result = callback(SHIFT_DOWN);
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

      const mockShowOverlay = mock(
        (_c: { render: (w: number) => string[] }, _o: Record<string, unknown>) => overlayHandle,
      );
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

      const mockShowOverlay = mock(
        (_c: { render: (w: number) => string[] }, _o: Record<string, unknown>) => overlayHandle1,
      );
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

  // ─── QR overlay (Ctrl+Q toggle) ────────────────────────────────────────
  //
  // The QR code is NOT rendered by default. prepareQrCode() pre-generates the
  // component; the user reveals/hides it on demand with Ctrl+Q (toggleQrCode).
  describe('prepareQrCode + Ctrl+Q toggle', () => {
    const CTRL_Q = '\x11';

    /**
     * Setup helper: spies on TUI.addInputListener/start/stop and captures the
     * global input callback so we can deliver keypresses, and mocks
     * showOverlay so we can assert the QR overlay lifecycle.
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
      const mockShowOverlay = mock(
        (_c: { render: (w: number) => string[] }, _o: Record<string, unknown>) => overlayHandle,
      );
      let capturedCallback: ((data: string) => any) | null = null;
      const addListenerSpy = spyOn(TUI.prototype, 'addInputListener').mockImplementation(function (
        this: any,
        cb: (data: string) => any,
      ) {
        capturedCallback = cb;
        this.requestRender = () => {};
        this.showOverlay = mockShowOverlay;
        return () => {};
      });
      const tuiStartSpy = spyOn(TUI.prototype, 'start').mockImplementation(() => {});
      const tuiStopSpy = spyOn(TUI.prototype, 'stop').mockImplementation(() => {});
      return {
        overlayHandle,
        mockShowOverlay,
        callback: () => capturedCallback!,
        cleanup: () => {
          addListenerSpy.mockRestore();
          tuiStartSpy.mockRestore();
          tuiStopSpy.mockRestore();
        },
      };
    }

    it('does NOT render the QR on start() even after prepareQrCode() (hidden by default)', async () => {
      const { mockShowOverlay, cleanup } = setupStartWithShowOverlaySpy();
      try {
        const wtui = new WorkflowTUI();
        await wtui.prepareQrCode('https://example.com');
        wtui.start();
        // QR is prepared but kept hidden until the user presses Ctrl+Q.
        expect(mockShowOverlay).not.toHaveBeenCalled();
      } finally {
        cleanup();
      }
    });

    it('Ctrl+Q shows the prepared QR overlay on demand', async () => {
      const { mockShowOverlay, callback, cleanup } = setupStartWithShowOverlaySpy();
      try {
        const wtui = new WorkflowTUI();
        await wtui.prepareQrCode('https://example.com');
        wtui.start();

        callback()(CTRL_Q);

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

    it('Ctrl+Q hides the QR overlay when it is already visible (toggle off)', async () => {
      const { overlayHandle, mockShowOverlay, callback, cleanup } = setupStartWithShowOverlaySpy();
      try {
        const wtui = new WorkflowTUI();
        await wtui.prepareQrCode('https://example.com');
        wtui.start();

        callback()(CTRL_Q); // show
        expect(mockShowOverlay).toHaveBeenCalledTimes(1);

        callback()(CTRL_Q); // hide
        expect(overlayHandle.hide).toHaveBeenCalledTimes(1);
        // No new overlay created on hide.
        expect(mockShowOverlay).toHaveBeenCalledTimes(1);
      } finally {
        cleanup();
      }
    });

    it('Ctrl+Q is a no-op when no QR was prepared', () => {
      const { mockShowOverlay, callback, cleanup } = setupStartWithShowOverlaySpy();
      try {
        const wtui = new WorkflowTUI();
        wtui.start();

        callback()(CTRL_Q);

        expect(mockShowOverlay).not.toHaveBeenCalled();
      } finally {
        cleanup();
      }
    });

    it('Ctrl+Q re-shows the QR after being hidden (idempotent toggle)', async () => {
      const { mockShowOverlay, callback, cleanup } = setupStartWithShowOverlaySpy();
      try {
        const wtui = new WorkflowTUI();
        await wtui.prepareQrCode('https://example.com');
        wtui.start();

        callback()(CTRL_Q); // show
        callback()(CTRL_Q); // hide
        callback()(CTRL_Q); // show again

        expect(mockShowOverlay).toHaveBeenCalledTimes(2);
      } finally {
        cleanup();
      }
    });
  });

  // ─── pauseForInspection (post-completion inspection) ─────────────────────
  //
  // After the run completes the TUI must STAY OPEN and remain fully
  // navigable until the user explicitly exits. pauseForInspection() no longer:
  //   • tears down the main input listener (all navigation stays live), nor
  //   • installs a separate Ctrl+C/Escape-only listener, nor
  //   • auto-resolves when the ClientStore status reaches 'complete'/'failed'.
  //
  // Instead it sets an `inspecting` flag and awaits a promise that is resolved
  // ONLY by:
  //   • Ctrl+C delivered through the MAIN input listener (graceful exit), or
  //   • the optional AbortSignal aborting.
  // Ctrl+D continues to detach immediately (unchanged).

  describe('pauseForInspection', () => {
    const CTRL_C = '\x03';
    const CTRL_D = '\x04';
    const ESCAPE = '\x1b';
    const SPACE = ' ';
    const RIGHT_ARROW = '\x1b[C';

    /**
     * Start a WorkflowTUI whose underlying TUI is mocked so we can:
     *   • capture the MAIN input listener installed in start()
     *   • spy on requestRender / showOverlay / addInputListener
     * The REAL EventLog and Dashboard are used so we can assert on render
     * output and navigation side effects.
     */
    function setupStartedPause(options: { clientStore?: ClientStore; onDetach?: () => void } = {}) {
      let capturedCallback: ((data: string) => any) | null = null;
      const requestRenderMock = mock(() => {});
      const overlayHandle = {
        hide: mock(() => {}),
        setHidden: mock(() => {}),
        isHidden: mock(() => false),
        focus: mock(() => {}),
        unfocus: mock(() => {}),
        isFocused: mock(() => false),
      };
      const showOverlayMock = mock(
        (_c: { render: (w: number) => string[]; handleInput: (d: string) => void }, _o: Record<string, unknown>) =>
          overlayHandle,
      );

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

      const ctorOpts: { clientStore?: ClientStore; onDetach?: () => void } = {};
      if (options.clientStore) ctorOpts.clientStore = options.clientStore;
      if (options.onDetach) ctorOpts.onDetach = options.onDetach;
      const wtui = new WorkflowTUI(ctorOpts);
      wtui.start();

      return {
        wtui,
        callback: () => capturedCallback!,
        requestRenderMock,
        showOverlayMock,
        overlayHandle,
        addListenerSpy,
        cleanup() {
          wtui.stop();
          addListenerSpy.mockRestore();
          tuiStartSpy.mockRestore();
          tuiStopSpy.mockRestore();
        },
      };
    }

    // ── guards ─────────────────────────────────────────────────────────

    it('does nothing when tui is null', async () => {
      const wtui = new WorkflowTUI();
      await expect(wtui.pauseForInspection()).resolves.toBeUndefined();
      expect(wtui.getEventLog().render(80).join('\n')).not.toContain('Workflow complete');
    });

    it('does nothing when not running', async () => {
      const wtui = new WorkflowTUI();
      (wtui as any).tui = { requestRender: mock(() => {}), addInputListener: mock(() => () => {}) } as any;
      (wtui as any).running = false;

      await expect(wtui.pauseForInspection()).resolves.toBeUndefined();
      expect(wtui.getEventLog().render(80).join('\n')).not.toContain('Workflow complete');
    });

    // ── hint line + render ─────────────────────────────────────────────

    it('adds a single hint line with the Ctrl+C / Ctrl+D exit instructions', async () => {
      const { wtui, callback, cleanup } = setupStartedPause();
      try {
        const promise = wtui.pauseForInspection();
        await Promise.resolve();

        const joined = wtui.getEventLog().render(80).join('\n');
        expect(joined).toContain('Workflow complete — Ctrl+C to exit · Ctrl+D to detach');
        // Exactly one hint line (no legacy blank line + message pair).
        const hintLines = wtui
          .getEventLog()
          .render(80)
          .filter((l) => l.includes('Workflow complete'));
        expect(hintLines).toHaveLength(1);

        callback()(CTRL_C);
        await promise;
      } finally {
        cleanup();
      }
    });

    it('requests a render after adding the hint line', async () => {
      const { wtui, requestRenderMock, callback, cleanup } = setupStartedPause();
      try {
        const before = requestRenderMock.mock.calls.length;
        const promise = wtui.pauseForInspection();
        await Promise.resolve();

        expect(requestRenderMock.mock.calls.length).toBeGreaterThan(before);

        callback()(CTRL_C);
        await promise;
      } finally {
        cleanup();
      }
    });

    // ── keeps the MAIN listener active ─────────────────────────────────

    it('does NOT install a separate input listener (main listener stays active)', async () => {
      const { wtui, addListenerSpy, callback, cleanup } = setupStartedPause();
      try {
        // addInputListener called exactly once — during start() — to install
        // the MAIN listener.
        expect(addListenerSpy).toHaveBeenCalledTimes(1);

        const promise = wtui.pauseForInspection();
        await Promise.resolve();

        // Still exactly one — pauseForInspection must NOT add its own listener.
        expect(addListenerSpy).toHaveBeenCalledTimes(1);

        callback()(CTRL_C);
        await promise;
      } finally {
        cleanup();
      }
    });

    it('still handles navigation keys (space) while inspecting', async () => {
      const { wtui, callback, requestRenderMock, cleanup } = setupStartedPause();
      try {
        const dashboard = wtui.getDashboard();
        expect(dashboard.agentLog.isExpanded()).toBe(false);

        const promise = wtui.pauseForInspection();
        await Promise.resolve();

        requestRenderMock.mockClear();

        // Space toggles the agent log expand — the main listener still routes it.
        const result = callback()(SPACE);
        expect(result).toEqual({ consume: true });
        expect(dashboard.agentLog.isExpanded()).toBe(true);
        expect(requestRenderMock).toHaveBeenCalled();

        callback()(CTRL_C);
        await promise;
      } finally {
        cleanup();
      }
    });

    it('still handles phase navigation (right arrow) while inspecting', async () => {
      const clientStore = new ClientStore();
      const { wtui, callback, cleanup } = setupStartedPause({ clientStore });
      try {
        clientStore.applyEvents([
          ev('phase_registered', { id: 'p1', label: 'P1', icon: '📋' }, {}, 1),
          ev('phase_registered', { id: 'p2', label: 'P2', icon: '📋' }, {}, 2),
          ev('phase_started', { phase: 'p1', round: 1 }, {}, 3),
        ]);

        const dashboard = wtui.getDashboard();
        expect(dashboard.getSelection().selectedPhaseId).toBe('p1');

        const promise = wtui.pauseForInspection();
        await Promise.resolve();

        // Right arrow navigates phases — the main listener still routes it.
        const result = callback()(RIGHT_ARROW);
        expect(result).toEqual({ consume: true });
        expect(dashboard.getSelection().selectedPhaseId).toBe('p2');

        callback()(CTRL_C);
        await promise;
      } finally {
        cleanup();
      }
    });

    // ── resolution via Ctrl+C (main listener) ──────────────────────────

    it('resolves when Ctrl+C is delivered through the MAIN input listener', async () => {
      const { wtui, callback, cleanup } = setupStartedPause();
      try {
        const promise = wtui.pauseForInspection();
        await Promise.resolve();

        let resolved = false;
        promise.then(() => {
          resolved = true;
        });

        const result = callback()(CTRL_C);
        expect(result).toEqual({ consume: true });

        await promise;
        expect(resolved).toBe(true);
      } finally {
        cleanup();
      }
    });

    it('Ctrl+C while inspecting resolves WITHOUT showing the detach/kill prompt', async () => {
      const { wtui, callback, showOverlayMock, cleanup } = setupStartedPause();
      try {
        const promise = wtui.pauseForInspection();
        await Promise.resolve();

        showOverlayMock.mockClear();

        callback()(CTRL_C);
        await promise;

        // The detach/kill prompt must NOT be opened during inspection.
        expect(showOverlayMock).not.toHaveBeenCalled();
      } finally {
        cleanup();
      }
    });

    it('Escape does NOT resolve the pause (only Ctrl+C exits)', async () => {
      const { wtui, callback, cleanup } = setupStartedPause();
      try {
        const controller = new AbortController();
        let resolved = false;
        const promise = wtui.pauseForInspection(controller.signal);
        promise.then(() => {
          resolved = true;
        });
        await Promise.resolve();

        // Escape falls through (unhandled) — the pause stays pending.
        const result = callback()(ESCAPE);
        expect(result).toBeUndefined();
        await new Promise((r) => setTimeout(r, 10));
        expect(resolved).toBe(false);

        // Settle via signal so no dangling promise leaks across tests.
        controller.abort();
        await promise;
      } finally {
        cleanup();
      }
    });

    // ── Ctrl+C while NOT inspecting still opens the prompt ─────────────

    it('Ctrl+C while NOT inspecting still shows the detach/kill prompt (existing behavior)', () => {
      const { callback, showOverlayMock, cleanup } = setupStartedPause();
      try {
        callback()(CTRL_C);
        expect(showOverlayMock).toHaveBeenCalledTimes(1);
      } finally {
        cleanup();
      }
    });

    // ── Ctrl+D unchanged (still detaches) ──────────────────────────────

    it('Ctrl+D during inspection still calls onDetach (unchanged)', async () => {
      const onDetachMock = mock(() => {});
      const { wtui, callback, cleanup } = setupStartedPause({ onDetach: onDetachMock });
      try {
        const promise = wtui.pauseForInspection();
        await Promise.resolve();

        const result = callback()(CTRL_D);
        expect(result).toEqual({ consume: true });
        expect(onDetachMock).toHaveBeenCalledTimes(1);

        // Ctrl+D detaches but does NOT resolve the pause; settle via Ctrl+C.
        callback()(CTRL_C);
        await promise;
      } finally {
        cleanup();
      }
    });

    // ── AbortSignal ────────────────────────────────────────────────────

    it('resolves immediately when signal is already aborted', async () => {
      const { wtui, addListenerSpy, callback, cleanup } = setupStartedPause();
      try {
        const signal = AbortSignal.abort();
        const start = performance.now();
        const promise = wtui.pauseForInspection(signal);

        // An already-aborted signal must resolve the pause without a keypress.
        // Race against a fallback Ctrl+C delivery so the test can never hang
        // if the early-return guard is absent.
        await Promise.race([promise, new Promise((r) => setTimeout(r, 60))]);
        const resolvedFast = performance.now() - start < 55;
        if (!resolvedFast) {
          callback()(CTRL_C);
        }
        await promise;

        expect(resolvedFast).toBe(true);
        // No separate pause listener was added beyond the single main one.
        expect(addListenerSpy).toHaveBeenCalledTimes(1);
      } finally {
        cleanup();
      }
    });

    it('resolves when signal is aborted after a tick (while inspecting)', async () => {
      const { wtui, cleanup } = setupStartedPause();
      try {
        const controller = new AbortController();
        const promise = wtui.pauseForInspection(controller.signal);
        await Promise.resolve();

        controller.abort();
        await expect(promise).resolves.toBeUndefined();
      } finally {
        cleanup();
      }
    });

    it('does NOT resolve while waiting (no Ctrl+C, no signal)', async () => {
      const { wtui, cleanup } = setupStartedPause();
      try {
        const controller = new AbortController();
        let resolved = false;
        const promise = wtui.pauseForInspection(controller.signal);
        promise.then(() => {
          resolved = true;
        });

        await new Promise((r) => setTimeout(r, 15));
        expect(resolved).toBe(false);

        // Settle the dangling promise.
        controller.abort();
        await promise;
      } finally {
        cleanup();
      }
    });

    it('resolves only once (signal abort after Ctrl+C does not double-resolve)', async () => {
      const { wtui, callback, cleanup } = setupStartedPause();
      try {
        const controller = new AbortController();
        let resolveCount = 0;
        const promise = wtui.pauseForInspection(controller.signal);
        promise.then(() => {
          resolveCount++;
        });

        callback()(CTRL_C);
        await promise;

        // Aborting the signal after resolution must not resolve again / throw.
        controller.abort();
        await new Promise((r) => setTimeout(r, 10));

        expect(resolveCount).toBe(1);
      } finally {
        cleanup();
      }
    });
  });

  // ─── pauseForInspection: NO auto-resolve on completion ───────────────────
  //
  // The post-completion inspection must NOT auto-resolve when the ClientStore
  // reaches a terminal status. The TUI stays open, fully navigable, until the
  // user presses Ctrl+C (graceful exit) or the AbortSignal fires. This
  // supersedes the old behavior where a 'complete'/'failed' status — or a
  // workflow_completed/workflow_failed event — resolved the pause immediately.

  describe('pauseForInspection (no auto-resolve on completion)', () => {
    const CTRL_C = '\x03';
    const SPACE = ' ';

    function setupClientStorePause() {
      const clientStore = new ClientStore();
      let capturedCallback: ((data: string) => any) | null = null;
      const requestRenderMock = mock(() => {});
      const showOverlayMock = mock(
        (_c: { render: (w: number) => string[]; handleInput: (d: string) => void }, _o: Record<string, unknown>) => ({
          hide: mock(() => {}),
          setHidden: mock(() => {}),
          isHidden: mock(() => false),
          focus: mock(() => {}),
          unfocus: mock(() => {}),
          isFocused: mock(() => false),
        }),
      );

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

      const wtui = new WorkflowTUI({ clientStore });
      wtui.start();

      return {
        wtui,
        clientStore,
        callback: () => capturedCallback!,
        requestRenderMock,
        cleanup() {
          wtui.stop();
          addListenerSpy.mockRestore();
          tuiStartSpy.mockRestore();
          tuiStopSpy.mockRestore();
        },
      };
    }

    it('does NOT auto-resolve when status is already "complete"', async () => {
      const { wtui, clientStore, callback, cleanup } = setupClientStorePause();
      try {
        clientStore.setStatus('complete');

        let resolved = false;
        const promise = wtui.pauseForInspection();
        promise.then(() => {
          resolved = true;
        });
        await new Promise((r) => setTimeout(r, 15));

        // Already-complete status must NOT auto-resolve the pause.
        expect(resolved).toBe(false);

        // It still resolves via Ctrl+C through the main listener.
        callback()(CTRL_C);
        await promise;
        expect(resolved).toBe(true);
      } finally {
        cleanup();
      }
    });

    it('does NOT auto-resolve when status is already "failed"', async () => {
      const { wtui, clientStore, callback, cleanup } = setupClientStorePause();
      try {
        clientStore.setStatus('failed');

        let resolved = false;
        const promise = wtui.pauseForInspection();
        promise.then(() => {
          resolved = true;
        });
        await new Promise((r) => setTimeout(r, 15));
        expect(resolved).toBe(false);

        callback()(CTRL_C);
        await promise;
      } finally {
        cleanup();
      }
    });

    it('does NOT auto-resolve when status transitions to "complete" after pause', async () => {
      const { wtui, clientStore, callback, cleanup } = setupClientStorePause();
      try {
        let resolved = false;
        const promise = wtui.pauseForInspection();
        promise.then(() => {
          resolved = true;
        });
        await Promise.resolve();

        clientStore.setStatus('complete');
        await new Promise((r) => setTimeout(r, 15));

        // A status transition to terminal must NOT resolve the pause.
        expect(resolved).toBe(false);

        callback()(CTRL_C);
        await promise;
      } finally {
        cleanup();
      }
    });

    it('does NOT auto-resolve when a workflow_completed event is applied', async () => {
      const { wtui, clientStore, callback, cleanup } = setupClientStorePause();
      try {
        let resolved = false;
        const promise = wtui.pauseForInspection();
        promise.then(() => {
          resolved = true;
        });
        await Promise.resolve();

        clientStore.applyEvents([ev('workflow_completed', { totalDurationMs: 1000, sessionCount: 1 }, {}, 1)]);
        await new Promise((r) => setTimeout(r, 15));
        expect(resolved).toBe(false);

        callback()(CTRL_C);
        await promise;
      } finally {
        cleanup();
      }
    });

    it('does NOT auto-resolve when a workflow_failed event is applied', async () => {
      const { wtui, clientStore, callback, cleanup } = setupClientStorePause();
      try {
        let resolved = false;
        const promise = wtui.pauseForInspection();
        promise.then(() => {
          resolved = true;
        });
        await Promise.resolve();

        clientStore.applyEvents([ev('workflow_failed', { phase: 'planning', error: 'boom' }, {}, 1)]);
        await new Promise((r) => setTimeout(r, 15));
        expect(resolved).toBe(false);

        callback()(CTRL_C);
        await promise;
      } finally {
        cleanup();
      }
    });

    it('does NOT register a client-store status subscription', async () => {
      const { wtui, clientStore, callback, cleanup } = setupClientStorePause();
      try {
        // The ws-backed adapter already subscribes once (in the constructor).
        const before = (clientStore as any).listeners.size;
        const promise = wtui.pauseForInspection();
        await Promise.resolve();

        // pauseForInspection must NOT add its own status listener.
        expect((clientStore as any).listeners.size).toBe(before);

        callback()(CTRL_C);
        await promise;
      } finally {
        cleanup();
      }
    });

    // ── Verification: complete status + Ctrl+C via main listener + nav keys

    it('verification: stays open at "complete", nav keys live, Ctrl+C exits', async () => {
      const { wtui, clientStore, callback, requestRenderMock, cleanup } = setupClientStorePause();
      try {
        clientStore.applyEvents([
          ev('phase_registered', { id: 'p1', label: 'P1', icon: '📋' }, {}, 1),
          ev('phase_started', { phase: 'p1', round: 1 }, {}, 2),
        ]);
        clientStore.setStatus('complete');

        // pauseForInspection must NOT resolve immediately despite 'complete'.
        let resolved = false;
        const promise = wtui.pauseForInspection();
        promise.then(() => {
          resolved = true;
        });
        await new Promise((r) => setTimeout(r, 10));
        expect(resolved).toBe(false);

        // Navigation keys are still handled while inspecting.
        requestRenderMock.mockClear();
        const spaceResult = callback()(SPACE);
        expect(spaceResult).toEqual({ consume: true });
        expect(requestRenderMock).toHaveBeenCalled();

        // Ctrl+C through the main listener resolves the pause.
        const ctrlCResult = callback()(CTRL_C);
        expect(ctrlCResult).toEqual({ consume: true });
        await promise;
        expect(resolved).toBe(true);
      } finally {
        cleanup();
      }
    });
  });
});
