/**
 * Tests for AgentLog – auto-scroll behavior and session tab bar.
 *
 * Verifies:
 * - Auto-scrolls to bottom when new log entries arrive and user is at bottom
 * - Does NOT auto-scroll when the user has scrolled up and new log entries arrive
 * - Re-enables auto-scroll when the user scrolls back to the bottom
 * - Auto-scrolls on agent switch (agent?.log reference changes, triggering effect)
 * - Handles empty / no-agent state gracefully
 * - Session tab bar renders with correct markers (done/active/pending)
 * - Clicking a session tab calls selectSession
 * - Sessions render in the session bar and not clickable
 *
 * The component now self-subscribes to the Zustand store — tests seed the
 * store directly instead of passing props.
 */

import '@testing-library/jest-dom/vitest';

import { act, fireEvent, render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LogEntry, SessionEntity, TaskEntity } from '../protocol-types';
import { useWorkflowStore } from '../store/workflow-store';

// ─── Constants ───────────────────────────────────────────────────────────────

const RUN_ID = 'run-1';

// ─── Mock useWebSocket ─────────────────────────────────────────────────────

const mockSend = vi.fn();

vi.mock('../hooks/useWebSocket', () => ({
  useWebSocket: vi.fn(() => ({
    send: mockSend,
    connected: true,
    hasConnectedOnce: true,
  })),
}));

// Must import AgentLog AFTER vi.mock so the mock is wired up
import { useWebSocket } from '../hooks/useWebSocket';
import { AgentLog } from './AgentLog';

// vi.mocked is not available in Vitest 4; cast the mocked import directly
const mockUseWebSocket = useWebSocket as unknown as ReturnType<typeof vi.fn>;

// ─── Helpers ───────────────────────────────────────────────────────────────

let entryCounter = 0;

function makeLogEntry(content: string, type: LogEntry['type'] = 'text'): LogEntry {
  entryCounter += 1;
  return {
    id: `log-${entryCounter}`,
    timestamp: new Date().toISOString(),
    type,
    content,
  };
}

function makeTaskEntity(id: string, overrides: Partial<TaskEntity> = {}): TaskEntity {
  return {
    id,
    title: `task-${id}`,
    phaseId: 'phase-1',
    status: 'active',
    dependencies: [],
    ...overrides,
  };
}

function makeAgentEntity(agentId: string, log: LogEntry[], overrides: Partial<SessionEntity> = {}): SessionEntity {
  const key = overrides.taskId ? `${agentId}::${overrides.taskId}` : agentId;
  return {
    uid: key,
    agentId,
    profile: 'test-profile',
    phaseId: 'phase-1',
    active: true,
    log,
    toolCallCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    taskTitle: '',
    runnerRole: 'executor',
    attempt: 1,
    ...overrides,
  };
}

/** Seed the store with tasks and sessions. */
function seedStore(
  tasks: Record<string, TaskEntity>,
  sessions: Record<string, SessionEntity>,
  overrides: Partial<{
    status: 'running' | 'complete' | 'failed';
    selectedPhaseId: string | null;
    selectedTaskId: string | null;
    selectedSessionId: string | null;
    currentPhaseId: string;
    completedPhaseIds: string[];
  }> = {},
): void {
  const {
    status = 'running',
    selectedPhaseId = null,
    selectedTaskId = null,
    selectedSessionId = null,
    currentPhaseId = 'phase-1',
    completedPhaseIds = [],
  } = overrides;

  useWorkflowStore.getState().applySnapshot(
    RUN_ID,
    {
      seq: 1,
      taskPrompt: '',
      phases: [{ id: 'phase-1', label: 'Test Phase', icon: '🔬', taskIds: Object.keys(tasks) }],
      currentPhaseId,
      completedPhaseIds,
      tasks,
      sessions,
      sidebar: { title: '', indicator: '' },
      status,
      stats: { totalTokens: 0, sessionCount: Object.keys(sessions).length },
      runLog: [],
    },
    1,
  );

  // Apply selection state after snapshot so reconcileSelection doesn't override
  act(() => {
    useWorkflowStore.setState({
      selectedPhaseId,
      selectedTaskId,
      selectedSessionId,
    });
  });
}

/** Seed the store wrapped in act() so React flushes the re-render. */
function seedStoreAct(
  tasks: Record<string, TaskEntity>,
  sessions: Record<string, SessionEntity>,
  overrides: Parameters<typeof seedStore>[2] = {},
): void {
  act(() => {
    seedStore(tasks, sessions, overrides);
  });
}

/** Helper: mock scrollHeight and clientHeight on a div. */
function mockScrollGeometry(el: HTMLDivElement, scrollHeight: number, clientHeight: number): void {
  Object.defineProperty(el, 'scrollHeight', {
    value: scrollHeight,
    configurable: true,
    writable: true,
  });
  Object.defineProperty(el, 'clientHeight', {
    value: clientHeight,
    configurable: true,
    writable: true,
  });
}

/** Helper: scroll a div to a given position and fire the scroll event. */
function scrollTo(el: HTMLDivElement, scrollTop: number): void {
  el.scrollTop = scrollTop;
  fireEvent.scroll(el);
}

/** Helper: get the scrollable entries container inside AgentLog. */
function getScrollContainer(container: HTMLElement): HTMLDivElement {
  return container.querySelector('.agent-log__entries') as HTMLDivElement;
}

// ─── Store reset ───────────────────────────────────────────────────────────

function resetStore(): void {
  useWorkflowStore.setState({
    sessionsById: {},
    tasksById: {},
    phases: [],
    currentPhaseId: '',
    completedPhaseIds: [],
    sidebar: { title: '', indicator: '' },
    status: 'running',
    taskPrompt: '',
    error: undefined,
    failedPhase: undefined,
    seq: 0,
    stats: { totalTokens: 0, sessionCount: 0 },
    workflowEventLog: [],
    selectedPhaseId: null,
    selectedTaskId: null,
    userPinnedPhase: false,
    runs: [],
    selectedRunId: RUN_ID,
    runLogs: {},
  });
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe('AgentLog – auto-scroll behavior (single agent)', () => {
  beforeEach(() => {
    entryCounter = 0;
    vi.restoreAllMocks();
    resetStore();
    mockUseWebSocket.mockReturnValue({ send: mockSend, connected: true, hasConnectedOnce: true });
  });

  it('auto-scrolls to bottom when new log entries arrive and user is at bottom', () => {
    const initialLog = [makeLogEntry('a'), makeLogEntry('b')];
    const task = makeTaskEntity('task-1', {});
    const agent = makeAgentEntity('agent-1', initialLog, { taskId: 'task-1' });

    seedStoreAct(
      { 'task-1': task },
      { 'agent-1::task-1': agent },
      { selectedTaskId: 'task-1', selectedSessionId: 'agent-1::task-1' },
    );

    const { container } = render(<AgentLog />);

    const scrollDiv = getScrollContainer(container);
    expect(scrollDiv).toBeInTheDocument();

    // Mock geometry BEFORE triggering the effect with new log entries
    mockScrollGeometry(scrollDiv, 1000, 200);

    // Add new log entries via the store
    const newLog = [...initialLog, makeLogEntry('c')];
    const updatedAgent = makeAgentEntity('agent-1', newLog, { taskId: 'task-1' });
    seedStoreAct(
      { 'task-1': task },
      { 'agent-1::task-1': updatedAgent },
      { selectedTaskId: 'task-1', selectedSessionId: 'agent-1::task-1' },
    );

    // With autoScroll=true initially → effect scrolls to bottom
    expect(scrollDiv.scrollTop).toBe(1000);
  });

  it('does NOT auto-scroll when user has scrolled up and new log entries arrive', () => {
    const initialLog = [makeLogEntry('a'), makeLogEntry('b'), makeLogEntry('c')];
    const task = makeTaskEntity('task-1', {});
    const agent = makeAgentEntity('agent-1', initialLog, { taskId: 'task-1' });

    seedStoreAct(
      { 'task-1': task },
      { 'agent-1::task-1': agent },
      { selectedTaskId: 'task-1', selectedSessionId: 'agent-1::task-1' },
    );

    const { container } = render(<AgentLog />);

    const scrollDiv = getScrollContainer(container);
    mockScrollGeometry(scrollDiv, 1000, 200);

    // Trigger initial auto-scroll with new entries
    const triggerLog = [...initialLog, makeLogEntry('d')];
    const triggerAgent = makeAgentEntity('agent-1', triggerLog, { taskId: 'task-1' });
    seedStoreAct(
      { 'task-1': task },
      { 'agent-1::task-1': triggerAgent },
      { selectedTaskId: 'task-1', selectedSessionId: 'agent-1::task-1' },
    );
    expect(scrollDiv.scrollTop).toBe(1000);

    // Simulate user scrolling up – far from bottom
    scrollTo(scrollDiv, 100);

    // Add more entries while scrolled up
    const newLog = [...triggerLog, makeLogEntry('e'), makeLogEntry('f')];
    const newAgent = makeAgentEntity('agent-1', newLog, { taskId: 'task-1' });
    seedStoreAct(
      { 'task-1': task },
      { 'agent-1::task-1': newAgent },
      { selectedTaskId: 'task-1', selectedSessionId: 'agent-1::task-1' },
    );

    // autoScroll is false, so scrollTop should NOT change.
    expect(scrollDiv.scrollTop).toBe(100);
  });

  it('re-enables auto-scroll when user scrolls back to bottom and new entries arrive', () => {
    const initialLog = [makeLogEntry('a'), makeLogEntry('b')];
    const task = makeTaskEntity('task-1', {});
    const agent = makeAgentEntity('agent-1', initialLog, { taskId: 'task-1' });

    seedStoreAct(
      { 'task-1': task },
      { 'agent-1::task-1': agent },
      { selectedTaskId: 'task-1', selectedSessionId: 'agent-1::task-1' },
    );

    const { container } = render(<AgentLog />);

    const scrollDiv = getScrollContainer(container);
    mockScrollGeometry(scrollDiv, 1000, 200);

    // Trigger initial auto-scroll
    const midLog = [...initialLog, makeLogEntry('c')];
    const midAgent = makeAgentEntity('agent-1', midLog, { taskId: 'task-1' });
    seedStoreAct(
      { 'task-1': task },
      { 'agent-1::task-1': midAgent },
      { selectedTaskId: 'task-1', selectedSessionId: 'agent-1::task-1' },
    );
    expect(scrollDiv.scrollTop).toBe(1000);

    // Scroll up (disables auto-scroll)
    scrollTo(scrollDiv, 100);
    expect(scrollDiv.scrollTop).toBe(100);

    // Add entries while scrolled up – should NOT scroll
    const nextLog = [...midLog, makeLogEntry('d')];
    const nextAgent = makeAgentEntity('agent-1', nextLog, { taskId: 'task-1' });
    seedStoreAct(
      { 'task-1': task },
      { 'agent-1::task-1': nextAgent },
      { selectedTaskId: 'task-1', selectedSessionId: 'agent-1::task-1' },
    );
    expect(scrollDiv.scrollTop).toBe(100);

    // Scroll back to bottom (within 30px threshold)
    scrollTo(scrollDiv, 970);

    // Add another entry – should auto-scroll now
    const finalLog = [...nextLog, makeLogEntry('e')];
    const finalAgent = makeAgentEntity('agent-1', finalLog, { taskId: 'task-1' });
    seedStoreAct(
      { 'task-1': task },
      { 'agent-1::task-1': finalAgent },
      { selectedTaskId: 'task-1', selectedSessionId: 'agent-1::task-1' },
    );

    expect(scrollDiv.scrollTop).toBe(1000);
  });

  it('maintains auto-scroll when already at bottom and new log entries arrive', () => {
    const initialLog = [makeLogEntry('a'), makeLogEntry('b')];
    const task = makeTaskEntity('task-1', {});
    const agent = makeAgentEntity('agent-1', initialLog, { taskId: 'task-1' });

    seedStoreAct(
      { 'task-1': task },
      { 'agent-1::task-1': agent },
      { selectedTaskId: 'task-1', selectedSessionId: 'agent-1::task-1' },
    );

    const { container } = render(<AgentLog />);

    const scrollDiv = getScrollContainer(container);
    mockScrollGeometry(scrollDiv, 1000, 200);

    // Trigger initial auto-scroll
    const midLog = [...initialLog, makeLogEntry('c')];
    const midAgent = makeAgentEntity('agent-1', midLog, { taskId: 'task-1' });
    seedStoreAct(
      { 'task-1': task },
      { 'agent-1::task-1': midAgent },
      { selectedTaskId: 'task-1', selectedSessionId: 'agent-1::task-1' },
    );
    expect(scrollDiv.scrollTop).toBe(1000);

    // Multiple new entries arrive while user is at bottom
    const newLog = [...midLog, makeLogEntry('d'), makeLogEntry('e'), makeLogEntry('f')];
    const newAgent = makeAgentEntity('agent-1', newLog, { taskId: 'task-1' });
    seedStoreAct(
      { 'task-1': task },
      { 'agent-1::task-1': newAgent },
      { selectedTaskId: 'task-1', selectedSessionId: 'agent-1::task-1' },
    );

    // Should still be at bottom
    expect(scrollDiv.scrollTop).toBe(1000);
  });
});

describe('AgentLog – auto-scroll on agent switch', () => {
  beforeEach(() => {
    entryCounter = 0;
    vi.restoreAllMocks();
    resetStore();
    mockUseWebSocket.mockReturnValue({ send: mockSend, connected: true, hasConnectedOnce: true });
  });

  it('auto-scrolls when switching between steps (agent log reference changes)', () => {
    const task = makeTaskEntity('task-1', {});
    const agent1 = makeAgentEntity('agent-1', [makeLogEntry('from agent 1')], { taskId: 'task-1' });
    const agent2 = makeAgentEntity('agent-2', [makeLogEntry('from agent 2')], { taskId: 'task-1' });

    // Render with empty store first so we can mock scroll geometry before seeding
    const { container } = render(<AgentLog />);
    const scrollDiv = getScrollContainer(container);
    mockScrollGeometry(scrollDiv, 1000, 200);

    // Seed with step 0 selected → triggers auto-scroll because agent?.log changes from undefined
    seedStoreAct(
      { 'task-1': task },
      { 'agent-1::task-1': agent1, 'agent-2::task-1': agent2 },
      { selectedTaskId: 'task-1', selectedSessionId: 'agent-1::task-1' },
    );
    expect(scrollDiv.scrollTop).toBe(1000);

    // Switch to session 1 (agent-2) by changing selectedSessionId
    seedStoreAct(
      { 'task-1': task },
      { 'agent-1::task-1': agent1, 'agent-2::task-1': agent2 },
      { selectedTaskId: 'task-1', selectedSessionId: 'agent-2::task-1' },
    );

    // autoScroll is true (user was at bottom), so effect scrolls.
    expect(scrollDiv.scrollTop).toBe(1000);
  });

  it('does not auto-scroll on step switch if user had scrolled up before switching', () => {
    const task = makeTaskEntity('task-1', {});
    const agent1 = makeAgentEntity('agent-1', [makeLogEntry('a1')], { taskId: 'task-1' });
    const agent2 = makeAgentEntity('agent-2', [makeLogEntry('b1')], { taskId: 'task-1' });

    // Render with empty store first so we can mock scroll geometry before seeding
    const { container } = render(<AgentLog />);
    const scrollDiv = getScrollContainer(container);
    mockScrollGeometry(scrollDiv, 1000, 200);

    // Seed with step 0 selected → triggers auto-scroll
    seedStoreAct(
      { 'task-1': task },
      { 'agent-1::task-1': agent1, 'agent-2::task-1': agent2 },
      { selectedTaskId: 'task-1', selectedSessionId: 'agent-1::task-1' },
    );
    expect(scrollDiv.scrollTop).toBe(1000);

    // Scroll up in agent-1 → autoScroll = false
    scrollTo(scrollDiv, 50);

    // Switch to session 1 (agent-2)
    seedStoreAct(
      { 'task-1': task },
      { 'agent-1::task-1': agent1, 'agent-2::task-1': agent2 },
      { selectedTaskId: 'task-1', selectedSessionId: 'agent-2::task-1' },
    );

    // autoScroll is false, so even though agent?.log changed, should NOT scroll.
    expect(scrollDiv.scrollTop).toBe(50);
  });
});

describe('AgentLog – empty / edge cases', () => {
  beforeEach(() => {
    entryCounter = 0;
    vi.restoreAllMocks();
    resetStore();
    mockUseWebSocket.mockReturnValue({ send: mockSend, connected: true, hasConnectedOnce: true });
  });

  it('renders without error when no task is selected', () => {
    seedStoreAct({}, {});

    const { container } = render(<AgentLog />);

    // Should show empty message
    expect(container.textContent).toContain('No agent selected');

    // Scroll container should exist but have no entries
    const scrollDiv = getScrollContainer(container);
    expect(scrollDiv).toBeInTheDocument();

    // No session bar should be rendered
    expect(container.querySelector('.agent-log__session-bar')).not.toBeInTheDocument();
  });

  it('renders without error when a task with sessions is selected', () => {
    const task = makeTaskEntity('task-1', {});
    const agent1 = makeAgentEntity('agent-1', [makeLogEntry('working')], {
      taskId: 'task-1',
      toolCallCount: 5,
      inputTokens: 100,
      outputTokens: 200,
    });

    seedStoreAct(
      { 'task-1': task },
      { 'agent-1::task-1': agent1 },
      { selectedTaskId: 'task-1', selectedSessionId: 'agent-1::task-1' },
    );

    const { container } = render(<AgentLog />);

    // Header should be visible showing task id or agent id
    const header = container.querySelector('.agent-log__header');
    expect(header).toBeInTheDocument();
    // The header shows taskId first if set, else agentId
    // agent has taskId: 'task-1', so 'task-1' appears in header
    expect(header?.textContent).toContain('task-1');
    expect(header?.textContent).toContain('5 tool calls');

    // Session bar should be rendered
    const sessionBar = container.querySelector('.agent-log__session-bar');
    expect(sessionBar).toBeInTheDocument();

    // Should have 1 session tab
    const tabs = container.querySelectorAll('.agent-log__session-tab');
    expect(tabs).toHaveLength(1);
  });

  it('handles new agent being added (agent log changes)', () => {
    const task = makeTaskEntity('task-1', {});

    // Render with empty store so we can mock scroll geometry first
    const { container } = render(<AgentLog />);
    const scrollDiv = getScrollContainer(container);
    mockScrollGeometry(scrollDiv, 1000, 200);

    // Seed task and agent — agent?.log changes undefined → [entry], triggering auto-scroll
    const agent = makeAgentEntity('agent-1', [makeLogEntry('initial')], { taskId: 'task-1' });
    seedStoreAct(
      { 'task-1': task },
      { 'agent-1::task-1': agent },
      { selectedTaskId: 'task-1', selectedSessionId: 'agent-1::task-1' },
    );
    expect(scrollDiv.scrollTop).toBe(1000);
  });

  it('shows "Connecting to workflow…" when no snapshot has arrived (seq=0)', () => {
    // Store is in initial state — seq=0, no snapshot
    const { container } = render(<AgentLog />);
    expect(container.textContent).toContain('Connecting to workflow…');
    expect(container.textContent).not.toContain('No agent selected');
  });
});

describe('AgentLog – session tab bar', () => {
  beforeEach(() => {
    entryCounter = 0;
    vi.restoreAllMocks();
    resetStore();
    mockUseWebSocket.mockReturnValue({ send: mockSend, connected: true, hasConnectedOnce: true });
  });

  it('renders session tabs for each session in the selected task', () => {
    const task = makeTaskEntity('task-1', {});
    const agent2 = makeAgentEntity('agent-2', [makeLogEntry('executing')], { taskId: 'task-1', profile: 'coder' });

    seedStoreAct(
      { 'task-1': task },
      {
        'agent-1::task-1': makeAgentEntity('agent-1', [], { taskId: 'task-1', profile: 'scout' }),
        'agent-2::task-1': agent2,
        'agent-3::task-1': makeAgentEntity('agent-3', [], { taskId: 'task-1', profile: 'reviewer' }),
      },
      { selectedTaskId: 'task-1', selectedSessionId: 'agent-2::task-1' },
    );

    const { container } = render(<AgentLog />);

    const tabs = container.querySelectorAll('.agent-log__session-tab');
    expect(tabs).toHaveLength(3);

    // Each tab shows the session profile name
    expect(tabs[0].querySelector('.agent-log__session-name')).toHaveTextContent('scout');
    expect(tabs[1].querySelector('.agent-log__session-name')).toHaveTextContent('coder');
    expect(tabs[2].querySelector('.agent-log__session-name')).toHaveTextContent('reviewer');
  });

  it('marks the selected session tab as selected', () => {
    const task = makeTaskEntity('task-1', {});
    const agent = makeAgentEntity('agent-1', [makeLogEntry('test')], { taskId: 'task-1' });

    seedStoreAct(
      { 'task-1': task },
      { 'agent-1::task-1': agent, 'agent-2::task-1': makeAgentEntity('agent-2', [], { taskId: 'task-1' }) },
      { selectedTaskId: 'task-1', selectedSessionId: 'agent-1::task-1' },
    );

    const { container } = render(<AgentLog />);

    const tabs = container.querySelectorAll('.agent-log__session-tab');
    expect(tabs[0]).toHaveClass('agent-log__session-tab--selected');
    expect(tabs[0]).toHaveAttribute('aria-selected', 'true');
    expect(tabs[1]).not.toHaveClass('agent-log__session-tab--selected');
    expect(tabs[1]).toHaveAttribute('aria-selected', 'false');
  });

  it('calls selectSession when a session tab is clicked', () => {
    const task = makeTaskEntity('task-1', {});
    const agent = makeAgentEntity('agent-1', [makeLogEntry('test')], { taskId: 'task-1' });

    const selectSessionSpy = vi.spyOn(useWorkflowStore.getState(), 'selectSession');

    seedStoreAct(
      { 'task-1': task },
      { 'agent-1::task-1': agent, 'agent-2::task-1': makeAgentEntity('agent-2', [], { taskId: 'task-1' }) },
      { selectedTaskId: 'task-1', selectedSessionId: 'agent-1::task-1' },
    );

    const { container } = render(<AgentLog />);

    const tabs = container.querySelectorAll('.agent-log__session-tab');
    expect(tabs).toHaveLength(2);

    // Click on the second session tab
    fireEvent.click(tabs[1]);
    expect(selectSessionSpy).toHaveBeenCalledTimes(1);
    expect(selectSessionSpy).toHaveBeenCalledWith('agent-2::task-1');

    selectSessionSpy.mockRestore();
  });

  it('renders all session tabs as clickable buttons', () => {
    const task = makeTaskEntity('task-1', {});
    const agent1 = makeAgentEntity('agent-1', [makeLogEntry('test')], { taskId: 'task-1', profile: 'coder' });
    const agent3 = makeAgentEntity('agent-3', [makeLogEntry('done')], { taskId: 'task-1', profile: 'reviewer' });

    const selectSessionSpy = vi.spyOn(useWorkflowStore.getState(), 'selectSession');

    seedStoreAct(
      { 'task-1': task },
      { 'agent-1::task-1': agent1, 'agent-3::task-1': agent3 },
      { selectedTaskId: 'task-1', selectedSessionId: 'agent-1::task-1' },
    );

    const { container } = render(<AgentLog />);

    const tabs = container.querySelectorAll('.agent-log__session-tab');
    expect(tabs).toHaveLength(2);
    expect(tabs[0]).not.toBeDisabled();
    expect(tabs[1]).not.toBeDisabled();

    // Click on the second session tab
    fireEvent.click(tabs[1]);
    expect(selectSessionSpy).toHaveBeenCalledTimes(1);
    expect(selectSessionSpy).toHaveBeenCalledWith('agent-3::task-1');

    // Click on the first session tab
    fireEvent.click(tabs[0]);
    expect(selectSessionSpy).toHaveBeenCalledTimes(2);
    expect(selectSessionSpy).toHaveBeenCalledWith('agent-1::task-1');

    selectSessionSpy.mockRestore();
  });

  it('shows session profile name in each tab', () => {
    const task = makeTaskEntity('task-1', {});
    const agent1 = makeAgentEntity('agent-1', [], { taskId: 'task-1', profile: 'coder' });
    const agent2 = makeAgentEntity('agent-2', [makeLogEntry('test')], { taskId: 'task-1', profile: 'reviewer' });

    seedStoreAct(
      { 'task-1': task },
      { 'agent-1::task-1': agent1, 'agent-2::task-1': agent2 },
      { selectedTaskId: 'task-1', selectedSessionId: 'agent-1::task-1' },
    );

    const { container } = render(<AgentLog />);

    const tabs = container.querySelectorAll('.agent-log__session-tab');

    // Tab 0: profile name
    expect(tabs[0].querySelector('.agent-log__session-name')).toHaveTextContent('coder');
    // Tab 1: profile name
    expect(tabs[1].querySelector('.agent-log__session-name')).toHaveTextContent('reviewer');
  });
});

describe('AgentLog – accessibility', () => {
  beforeEach(() => {
    entryCounter = 0;
    vi.restoreAllMocks();
    resetStore();
    mockUseWebSocket.mockReturnValue({ send: mockSend, connected: true, hasConnectedOnce: true });
  });

  it('adds role="tablist" to session bar', () => {
    const task = makeTaskEntity('task-1', {});
    const agent = makeAgentEntity('agent-1', [makeLogEntry('a')], { taskId: 'task-1' });

    seedStoreAct(
      { 'task-1': task },
      { 'agent-1::task-1': agent },
      { selectedTaskId: 'task-1', selectedSessionId: 'agent-1::task-1' },
    );

    const { container } = render(<AgentLog />);

    const sessionBar = container.querySelector('.agent-log__session-bar');
    expect(sessionBar).toHaveAttribute('role', 'tablist');
    expect(sessionBar).toHaveAttribute('aria-label', 'Task sessions');
  });

  it('renders readable token stats with Input/Output labels', () => {
    const task = makeTaskEntity('task-1', {});
    const agent = makeAgentEntity('agent-1', [makeLogEntry('a')], {
      taskId: 'task-1',
      inputTokens: 123,
      outputTokens: 456,
      toolCallCount: 3,
    });

    seedStoreAct(
      { 'task-1': task },
      { 'agent-1::task-1': agent },
      { selectedTaskId: 'task-1', selectedSessionId: 'agent-1::task-1' },
    );

    const { container } = render(<AgentLog />);

    const header = container.querySelector('.agent-log__header');
    expect(header).toBeInTheDocument();
    expect(header?.textContent).toContain('Input: 123');
    expect(header?.textContent).toContain('Output: 456');
    expect(header?.textContent).toContain('3 tool calls');
    expect(header?.textContent).not.toContain('↑');
    expect(header?.textContent).not.toContain('↓');
  });
});

describe('AgentLog – terminate button (connected state)', () => {
  beforeEach(() => {
    entryCounter = 0;
    vi.restoreAllMocks();
    resetStore();
    mockSend.mockClear();
  });

  it('shows terminate button when status is running and connected is true', () => {
    mockUseWebSocket.mockReturnValue({ send: mockSend, connected: true, hasConnectedOnce: true });
    const task = makeTaskEntity('task-1', {});
    const agent = makeAgentEntity('agent-1', [makeLogEntry('running')], { taskId: 'task-1' });
    seedStoreAct(
      { 'task-1': task },
      { 'agent-1::task-1': agent },
      { selectedTaskId: 'task-1', selectedSessionId: 'agent-1::task-1' },
    );

    const { container } = render(<AgentLog />);

    const button = container.querySelector('.agent-log__terminate');
    expect(button).toBeInTheDocument();
    expect(button).not.toBeDisabled();
    expect(button).toHaveTextContent('Terminate Workflow');
  });

  it('shows terminate button as disabled with feedback text when disconnected', () => {
    mockUseWebSocket.mockReturnValue({ send: mockSend, connected: false, hasConnectedOnce: true });
    const task = makeTaskEntity('task-1', {});
    const agent = makeAgentEntity('agent-1', [makeLogEntry('running')], { taskId: 'task-1' });
    seedStoreAct(
      { 'task-1': task },
      { 'agent-1::task-1': agent },
      { selectedTaskId: 'task-1', selectedSessionId: 'agent-1::task-1' },
    );

    const { container } = render(<AgentLog />);

    const button = container.querySelector('.agent-log__terminate');
    expect(button).toBeInTheDocument();
    expect(button).toBeDisabled();
    expect(button).toHaveTextContent('Disconnected - Reconnecting...');
  });

  it('does not render terminate button when status is complete', () => {
    mockUseWebSocket.mockReturnValue({ send: mockSend, connected: true, hasConnectedOnce: true });
    const task = makeTaskEntity('task-1', {});
    const agent = makeAgentEntity('agent-1', [makeLogEntry('done')], { taskId: 'task-1' });
    seedStoreAct(
      { 'task-1': task },
      { 'agent-1::task-1': agent },
      { selectedTaskId: 'task-1', selectedSessionId: 'agent-1::task-1', status: 'complete' },
    );

    const { container } = render(<AgentLog />);

    const button = container.querySelector('.agent-log__terminate');
    expect(button).not.toBeInTheDocument();
  });

  it('does not render terminate button when status is failed', () => {
    mockUseWebSocket.mockReturnValue({ send: mockSend, connected: true, hasConnectedOnce: true });
    const task = makeTaskEntity('task-1', {});
    const agent = makeAgentEntity('agent-1', [makeLogEntry('error')], { taskId: 'task-1' });
    seedStoreAct(
      { 'task-1': task },
      { 'agent-1::task-1': agent },
      { selectedTaskId: 'task-1', selectedSessionId: 'agent-1::task-1', status: 'failed' },
    );

    const { container } = render(<AgentLog />);

    const button = container.querySelector('.agent-log__terminate');
    expect(button).not.toBeInTheDocument();
  });

  it('calls send with cancel_run after two clicks (confirmation flow)', () => {
    mockUseWebSocket.mockReturnValue({ send: mockSend, connected: true, hasConnectedOnce: true });
    const task = makeTaskEntity('task-1', {});
    const agent = makeAgentEntity('agent-1', [makeLogEntry('running')], { taskId: 'task-1' });
    seedStoreAct(
      { 'task-1': task },
      { 'agent-1::task-1': agent },
      { selectedTaskId: 'task-1', selectedSessionId: 'agent-1::task-1' },
    );

    const { container } = render(<AgentLog />);

    const button = container.querySelector('.agent-log__terminate')!;

    // First click → enters confirmation state, does NOT send yet
    fireEvent.click(button);
    expect(mockSend).not.toHaveBeenCalled();
    expect(button).toHaveTextContent('Confirm termination');

    // Second click → actually sends
    fireEvent.click(button);
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(mockSend).toHaveBeenCalledWith({ type: 'cancel_run', runId: RUN_ID });
  });

  it('shows Cancel button in confirmation state and cancels termination', () => {
    mockUseWebSocket.mockReturnValue({ send: mockSend, connected: true, hasConnectedOnce: true });
    const task = makeTaskEntity('task-1', {});
    const agent = makeAgentEntity('agent-1', [makeLogEntry('running')], { taskId: 'task-1' });
    seedStoreAct(
      { 'task-1': task },
      { 'agent-1::task-1': agent },
      { selectedTaskId: 'task-1', selectedSessionId: 'agent-1::task-1' },
    );

    const { container } = render(<AgentLog />);

    const terminateBtn = container.querySelector('.agent-log__terminate')!;
    expect(container.querySelector('.agent-log__cancel')).not.toBeInTheDocument();

    // First click → confirmation state
    fireEvent.click(terminateBtn);
    expect(terminateBtn).toHaveTextContent('Confirm termination');

    const cancelBtn = container.querySelector('.agent-log__cancel') as HTMLButtonElement;
    expect(cancelBtn).toBeInTheDocument();

    // Cancel → back to initial state
    fireEvent.click(cancelBtn);
    expect(mockSend).not.toHaveBeenCalled();
    const restoreBtn = container.querySelector('.agent-log__terminate')!;
    expect(restoreBtn).toHaveTextContent('Terminate Workflow');
    expect(container.querySelector('.agent-log__cancel')).not.toBeInTheDocument();
  });

  it('does not call send when button is clicked while disconnected', () => {
    mockUseWebSocket.mockReturnValue({ send: mockSend, connected: false, hasConnectedOnce: true });
    const task = makeTaskEntity('task-1', {});
    const agent = makeAgentEntity('agent-1', [makeLogEntry('running')], { taskId: 'task-1' });
    seedStoreAct(
      { 'task-1': task },
      { 'agent-1::task-1': agent },
      { selectedTaskId: 'task-1', selectedSessionId: 'agent-1::task-1' },
    );

    const { container } = render(<AgentLog />);

    const button = container.querySelector('.agent-log__terminate')!;
    expect(button).toBeDisabled();

    fireEvent.click(button);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('has correct CSS class on the terminate button', () => {
    mockUseWebSocket.mockReturnValue({ send: mockSend, connected: true, hasConnectedOnce: true });
    const task = makeTaskEntity('task-1', {});
    const agent = makeAgentEntity('agent-1', [makeLogEntry('running')], { taskId: 'task-1' });
    seedStoreAct(
      { 'task-1': task },
      { 'agent-1::task-1': agent },
      { selectedTaskId: 'task-1', selectedSessionId: 'agent-1::task-1' },
    );

    const { container } = render(<AgentLog />);

    const button = container.querySelector('.agent-log__terminate');
    expect(button).toHaveClass('agent-log__terminate');
  });

  it('transitions button text from connected to disconnected when connected changes', () => {
    mockUseWebSocket.mockReturnValue({ send: mockSend, connected: true, hasConnectedOnce: true });
    const task = makeTaskEntity('task-1', {});
    const agent = makeAgentEntity('agent-1', [makeLogEntry('running')], { taskId: 'task-1' });
    seedStoreAct(
      { 'task-1': task },
      { 'agent-1::task-1': agent },
      { selectedTaskId: 'task-1', selectedSessionId: 'agent-1::task-1' },
    );

    const { container, rerender } = render(<AgentLog />);

    const button = container.querySelector('.agent-log__terminate')!;
    expect(button).toHaveTextContent('Terminate Workflow');
    expect(button).not.toBeDisabled();

    // Simulate disconnect
    mockUseWebSocket.mockReturnValue({ send: mockSend, connected: false, hasConnectedOnce: true });
    rerender(<AgentLog />);

    expect(button).toHaveTextContent('Disconnected - Reconnecting...');
    expect(button).toBeDisabled();
  });

  it('does not render terminate button when status transitions to complete', () => {
    mockUseWebSocket.mockReturnValue({ send: mockSend, connected: true, hasConnectedOnce: true });
    const task = makeTaskEntity('task-1', {});
    const agent = makeAgentEntity('agent-1', [makeLogEntry('done')], { taskId: 'task-1' });
    seedStoreAct(
      { 'task-1': task },
      { 'agent-1::task-1': agent },
      { selectedTaskId: 'task-1', selectedSessionId: 'agent-1::task-1' },
    );

    const { container, rerender } = render(<AgentLog />);

    expect(container.querySelector('.agent-log__terminate')).toBeInTheDocument();

    // Status changes to complete
    act(() => {
      useWorkflowStore.getState().setStatus(RUN_ID, 'complete');
    });
    rerender(<AgentLog />);

    expect(container.querySelector('.agent-log__terminate')).not.toBeInTheDocument();
  });

  it('does not render terminate button when status transitions to failed', () => {
    mockUseWebSocket.mockReturnValue({ send: mockSend, connected: true, hasConnectedOnce: true });
    const task = makeTaskEntity('task-1', {});
    const agent = makeAgentEntity('agent-1', [makeLogEntry('error')], { taskId: 'task-1' });
    seedStoreAct(
      { 'task-1': task },
      { 'agent-1::task-1': agent },
      { selectedTaskId: 'task-1', selectedSessionId: 'agent-1::task-1' },
    );

    const { container, rerender } = render(<AgentLog />);

    expect(container.querySelector('.agent-log__terminate')).toBeInTheDocument();

    // Status changes to failed
    act(() => {
      useWorkflowStore.getState().setStatus(RUN_ID, 'failed');
    });
    rerender(<AgentLog />);

    expect(container.querySelector('.agent-log__terminate')).not.toBeInTheDocument();
  });
});
