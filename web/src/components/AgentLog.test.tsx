/**
 * Tests for AgentLog – auto-scroll behavior.
 *
 * Verifies:
 * - Auto-scrolls to bottom when new log entries arrive and user is at bottom
 * - Does NOT auto-scroll when the user has scrolled up and new log entries arrive
 * - Re-enables auto-scroll when the user scrolls back to the bottom
 * - Auto-scrolls on agent switch (agent?.log reference changes, triggering effect)
 * - Handles empty / no-agent state gracefully
 *
 * The component now self-subscribes to the Zustand store — tests seed the
 * store directly instead of passing props.
 */

import '@testing-library/jest-dom/vitest';

import { act, fireEvent, render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEntity, LogEntry } from '../protocol-types';
import { useWorkflowStore } from '../store/workflow-store';

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

function makeAgentEntity(agentId: string, log: LogEntry[], overrides: Partial<AgentEntity> = {}): AgentEntity {
  const key = overrides.taskId ? `${agentId}::${overrides.taskId}` : agentId;
  return {
    uid: key,
    agentId,
    profile: 'test-profile',
    phase: '',
    active: true,
    log,
    toolCallCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    taskTitle: '',
    ...overrides,
  };
}

/** Seed the store with agents. */
function seedStore(agents: Record<string, AgentEntity>): void {
  useWorkflowStore.getState().applySnapshot(
    {
      seq: 1,
      taskPrompt: '',
      currentPhase: '',
      completedPhases: [],
      tasks: {},
      agents,
      sidebar: { title: '', indicator: '' },
      status: 'running',
      stats: { totalTokens: 0, agentCount: Object.keys(agents).length },
    },
    1,
  );
}

/** Seed the store wrapped in act() so React flushes the re-render. */
function seedStoreAct(agents: Record<string, AgentEntity>): void {
  act(() => {
    seedStore(agents);
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
    agentsById: {},
    tasksById: {},
    currentPhase: '',
    completedPhases: [],
    sidebar: { title: '', indicator: '' },
    status: 'running',
    taskPrompt: '',
    error: undefined,
    failedPhase: undefined,
    seq: 0,
    stats: { totalTokens: 0, agentCount: 0 },
    workflowEventLog: [],
  });
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe('AgentLog – auto-scroll behavior (single agent)', () => {
  beforeEach(() => {
    entryCounter = 0;
    vi.restoreAllMocks();
    resetStore();
    vi.mocked(useWebSocket).mockReturnValue({ send: mockSend, connected: true, hasConnectedOnce: true });
  });

  it('auto-scrolls to bottom when new log entries arrive and user is at bottom', () => {
    const initialLog = [makeLogEntry('a'), makeLogEntry('b')];
    seedStoreAct({ 'agent-1': makeAgentEntity('agent-1', initialLog) });

    const { container } = render(<AgentLog />);

    const scrollDiv = getScrollContainer(container);
    expect(scrollDiv).toBeInTheDocument();

    // Mock geometry BEFORE triggering the effect with new log entries
    mockScrollGeometry(scrollDiv, 1000, 200);

    // Add new log entries via the store
    const newLog = [...initialLog, makeLogEntry('c')];
    seedStoreAct({ 'agent-1': makeAgentEntity('agent-1', newLog) });

    // With autoScroll=true initially → effect scrolls to bottom
    expect(scrollDiv.scrollTop).toBe(1000);
  });

  it('does NOT auto-scroll when user has scrolled up and new log entries arrive', () => {
    const initialLog = [makeLogEntry('a'), makeLogEntry('b'), makeLogEntry('c')];
    seedStoreAct({ 'agent-1': makeAgentEntity('agent-1', initialLog) });

    const { container } = render(<AgentLog />);

    const scrollDiv = getScrollContainer(container);
    mockScrollGeometry(scrollDiv, 1000, 200);

    // Trigger initial auto-scroll with new entries
    const triggerLog = [...initialLog, makeLogEntry('d')];
    seedStoreAct({ 'agent-1': makeAgentEntity('agent-1', triggerLog) });
    expect(scrollDiv.scrollTop).toBe(1000);

    // Simulate user scrolling up – far from bottom
    scrollTo(scrollDiv, 100);

    // Add more entries while scrolled up
    const newLog = [...triggerLog, makeLogEntry('e'), makeLogEntry('f')];
    seedStoreAct({ 'agent-1': makeAgentEntity('agent-1', newLog) });

    // autoScroll is false, so scrollTop should NOT change.
    expect(scrollDiv.scrollTop).toBe(100);
  });

  it('re-enables auto-scroll when user scrolls back to bottom and new entries arrive', () => {
    const initialLog = [makeLogEntry('a'), makeLogEntry('b')];
    seedStoreAct({ 'agent-1': makeAgentEntity('agent-1', initialLog) });

    const { container } = render(<AgentLog />);

    const scrollDiv = getScrollContainer(container);
    mockScrollGeometry(scrollDiv, 1000, 200);

    // Trigger initial auto-scroll
    seedStoreAct({
      'agent-1': makeAgentEntity('agent-1', [...initialLog, makeLogEntry('c')]),
    });
    expect(scrollDiv.scrollTop).toBe(1000);

    // Scroll up (disables auto-scroll)
    scrollTo(scrollDiv, 100);
    expect(scrollDiv.scrollTop).toBe(100);

    // Add entries while scrolled up – should NOT scroll
    seedStoreAct({
      'agent-1': makeAgentEntity('agent-1', [...initialLog, makeLogEntry('c'), makeLogEntry('d')]),
    });
    expect(scrollDiv.scrollTop).toBe(100);

    // Scroll back to bottom (within 30px threshold)
    scrollTo(scrollDiv, 970);

    // Add another entry – should auto-scroll now
    seedStoreAct({
      'agent-1': makeAgentEntity('agent-1', [...initialLog, makeLogEntry('c'), makeLogEntry('d'), makeLogEntry('e')]),
    });

    expect(scrollDiv.scrollTop).toBe(1000);
  });

  it('maintains auto-scroll when already at bottom and new log entries arrive', () => {
    const initialLog = [makeLogEntry('a'), makeLogEntry('b')];
    seedStoreAct({ 'agent-1': makeAgentEntity('agent-1', initialLog) });

    const { container } = render(<AgentLog />);

    const scrollDiv = getScrollContainer(container);
    mockScrollGeometry(scrollDiv, 1000, 200);

    // Trigger initial auto-scroll
    const midLog = [...initialLog, makeLogEntry('c')];
    seedStoreAct({ 'agent-1': makeAgentEntity('agent-1', midLog) });
    expect(scrollDiv.scrollTop).toBe(1000);

    // Multiple new entries arrive while user is at bottom
    const newLog = [...midLog, makeLogEntry('d'), makeLogEntry('e'), makeLogEntry('f')];
    seedStoreAct({ 'agent-1': makeAgentEntity('agent-1', newLog) });

    // Should still be at bottom
    expect(scrollDiv.scrollTop).toBe(1000);
  });
});

describe('AgentLog – auto-scroll on agent switch', () => {
  beforeEach(() => {
    entryCounter = 0;
    vi.restoreAllMocks();
    resetStore();
    vi.mocked(useWebSocket).mockReturnValue({ send: mockSend, connected: true, hasConnectedOnce: true });
  });

  it('auto-scrolls when switching to a different agent (log reference changes)', () => {
    seedStoreAct({
      'agent-1': makeAgentEntity('agent-1', [makeLogEntry('from agent 1')]),
      'agent-2': makeAgentEntity('agent-2', [makeLogEntry('from agent 2')]),
    });

    const { container } = render(<AgentLog />);

    const scrollDiv = getScrollContainer(container);
    mockScrollGeometry(scrollDiv, 1000, 200);

    // Trigger initial auto-scroll on agent-1
    seedStoreAct({
      'agent-1': makeAgentEntity('agent-1', [makeLogEntry('from agent 1')]),
      'agent-2': makeAgentEntity('agent-2', [makeLogEntry('from agent 2')]),
    });
    expect(scrollDiv.scrollTop).toBe(1000);

    // Switch to agent-2 by removing agent-1 from the store
    seedStoreAct({
      'agent-2': makeAgentEntity('agent-2', [makeLogEntry('from agent 2')]),
    });

    // autoScroll is true (user was at bottom), so effect scrolls.
    expect(scrollDiv.scrollTop).toBe(1000);
  });

  it('does not auto-scroll on agent switch if user had scrolled up before switching', () => {
    seedStoreAct({
      'agent-1': makeAgentEntity('agent-1', [makeLogEntry('a1')]),
      'agent-2': makeAgentEntity('agent-2', [makeLogEntry('b1')]),
    });

    const { container } = render(<AgentLog />);

    const scrollDiv = getScrollContainer(container);
    mockScrollGeometry(scrollDiv, 1000, 200);

    // Trigger initial auto-scroll (agent-1 selected)
    seedStoreAct({
      'agent-1': makeAgentEntity('agent-1', [makeLogEntry('a1')]),
      'agent-2': makeAgentEntity('agent-2', [makeLogEntry('b1')]),
    });
    expect(scrollDiv.scrollTop).toBe(1000);

    // Scroll up in agent-1 → autoScroll = false
    scrollTo(scrollDiv, 50);

    // Switch to agent-2
    seedStoreAct({
      'agent-2': makeAgentEntity('agent-2', [makeLogEntry('b1')]),
    });

    // autoScroll is false, so even though agent?.log changed, should NOT scroll.
    expect(scrollDiv.scrollTop).toBe(50);
  });
});

describe('AgentLog – empty / edge cases', () => {
  beforeEach(() => {
    entryCounter = 0;
    vi.restoreAllMocks();
    resetStore();
    vi.mocked(useWebSocket).mockReturnValue({ send: mockSend, connected: true, hasConnectedOnce: true });
  });

  it('renders without error when agents map is empty', () => {
    seedStoreAct({});

    const { container } = render(<AgentLog />);

    // Should show "No agent selected"
    expect(container.textContent).toContain('No agent selected');

    // Scroll container should exist but have no entries
    const scrollDiv = getScrollContainer(container);
    expect(scrollDiv).toBeInTheDocument();
  });

  it('handles new agent being added (keys length changes)', () => {
    const initialLog = [makeLogEntry('initial')];

    // Render with empty store so we can mock scroll geometry first
    const { container } = render(<AgentLog />);
    const scrollDiv = getScrollContainer(container);
    mockScrollGeometry(scrollDiv, 1000, 200);

    // Seed agent data — agent?.log changes undefined → initialLog, triggering auto-scroll
    seedStoreAct({ 'agent-1': makeAgentEntity('agent-1', initialLog) });
    expect(scrollDiv.scrollTop).toBe(1000);

    // Add a new agent
    seedStoreAct({
      'agent-1': makeAgentEntity('agent-1', initialLog),
      'agent-2': makeAgentEntity('agent-2', [makeLogEntry('new agent')]),
    });

    // selectedIndex was 0, keys length changed from 1 to 2, but 0 < 2, so selection stays
    // autoScroll should still be true → effect scrolls to bottom
    expect(scrollDiv.scrollTop).toBe(1000);
  });

  it('shows "Connecting to workflow…" when no snapshot has arrived (seq=0)', () => {
    // Store is in initial state — seq=0, no snapshot
    const { container } = render(<AgentLog />);
    expect(container.textContent).toContain('Connecting to workflow…');
    expect(container.textContent).not.toContain('No agent selected');
  });
});

describe('AgentLog – accessibility', () => {
  beforeEach(() => {
    entryCounter = 0;
    vi.restoreAllMocks();
    resetStore();
    vi.mocked(useWebSocket).mockReturnValue({ send: mockSend, connected: true, hasConnectedOnce: true });
  });

  it('adds aria-label to previous/next nav buttons', () => {
    seedStoreAct({
      'agent-1': makeAgentEntity('agent-1', [makeLogEntry('a')]),
      'agent-2': makeAgentEntity('agent-2', [makeLogEntry('b')]),
    });

    const { container } = render(<AgentLog />);

    const buttons = container.querySelectorAll('.agent-log__nav-btn');
    expect(buttons).toHaveLength(2);
    expect(buttons[0]).toHaveAttribute('aria-label', 'Previous agent');
    expect(buttons[1]).toHaveAttribute('aria-label', 'Next agent');
  });

  it('renders readable token stats with Input/Output labels', () => {
    seedStoreAct({
      'agent-1': makeAgentEntity('agent-1', [makeLogEntry('a')], {
        inputTokens: 123,
        outputTokens: 456,
        toolCallCount: 3,
      }),
    });

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
    vi.mocked(useWebSocket).mockReturnValue({ send: mockSend, connected: true, hasConnectedOnce: true });
    seedStoreAct({ 'agent-1': makeAgentEntity('agent-1', [makeLogEntry('running')]) });

    const { container } = render(<AgentLog />);

    const button = container.querySelector('.agent-log__terminate');
    expect(button).toBeInTheDocument();
    expect(button).not.toBeDisabled();
    expect(button).toHaveTextContent('Terminate Workflow');
  });

  it('shows terminate button as disabled with feedback text when disconnected', () => {
    vi.mocked(useWebSocket).mockReturnValue({ send: mockSend, connected: false, hasConnectedOnce: true });
    seedStoreAct({ 'agent-1': makeAgentEntity('agent-1', [makeLogEntry('running')]) });

    const { container } = render(<AgentLog />);

    const button = container.querySelector('.agent-log__terminate');
    expect(button).toBeInTheDocument();
    expect(button).toBeDisabled();
    expect(button).toHaveTextContent('Disconnected - Reconnecting...');
  });

  it('does not render terminate button when status is complete', () => {
    vi.mocked(useWebSocket).mockReturnValue({ send: mockSend, connected: true, hasConnectedOnce: true });
    seedStore({ 'agent-1': makeAgentEntity('agent-1', [makeLogEntry('done')]) });
    act(() => {
      useWorkflowStore.getState().setStatus('complete');
    });

    const { container } = render(<AgentLog />);

    const button = container.querySelector('.agent-log__terminate');
    expect(button).not.toBeInTheDocument();
  });

  it('does not render terminate button when status is failed', () => {
    vi.mocked(useWebSocket).mockReturnValue({ send: mockSend, connected: true, hasConnectedOnce: true });
    seedStore({ 'agent-1': makeAgentEntity('agent-1', [makeLogEntry('error')]) });
    act(() => {
      useWorkflowStore.getState().setStatus('failed');
    });

    const { container } = render(<AgentLog />);

    const button = container.querySelector('.agent-log__terminate');
    expect(button).not.toBeInTheDocument();
  });

  it('calls send with terminate_server after two clicks (confirmation flow)', () => {
    vi.mocked(useWebSocket).mockReturnValue({ send: mockSend, connected: true, hasConnectedOnce: true });
    seedStoreAct({ 'agent-1': makeAgentEntity('agent-1', [makeLogEntry('running')]) });

    const { container } = render(<AgentLog />);

    const button = container.querySelector('.agent-log__terminate')!;

    // First click → enters confirmation state, does NOT send yet
    fireEvent.click(button);
    expect(mockSend).not.toHaveBeenCalled();
    expect(button).toHaveTextContent('Confirm termination');

    // Second click → actually sends
    fireEvent.click(button);
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(mockSend).toHaveBeenCalledWith({ type: 'terminate_server' });
  });

  it('shows Cancel button in confirmation state and cancels termination', () => {
    vi.mocked(useWebSocket).mockReturnValue({ send: mockSend, connected: true, hasConnectedOnce: true });
    seedStoreAct({ 'agent-1': makeAgentEntity('agent-1', [makeLogEntry('running')]) });

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
    vi.mocked(useWebSocket).mockReturnValue({ send: mockSend, connected: false, hasConnectedOnce: true });
    seedStoreAct({ 'agent-1': makeAgentEntity('agent-1', [makeLogEntry('running')]) });

    const { container } = render(<AgentLog />);

    const button = container.querySelector('.agent-log__terminate')!;
    expect(button).toBeDisabled();

    fireEvent.click(button);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('has correct CSS class on the terminate button', () => {
    vi.mocked(useWebSocket).mockReturnValue({ send: mockSend, connected: true, hasConnectedOnce: true });
    seedStoreAct({ 'agent-1': makeAgentEntity('agent-1', [makeLogEntry('running')]) });

    const { container } = render(<AgentLog />);

    const button = container.querySelector('.agent-log__terminate');
    expect(button).toHaveClass('agent-log__terminate');
  });

  it('transitions button text from connected to disconnected when connected changes', () => {
    vi.mocked(useWebSocket).mockReturnValue({ send: mockSend, connected: true, hasConnectedOnce: true });
    seedStoreAct({ 'agent-1': makeAgentEntity('agent-1', [makeLogEntry('running')]) });

    const { container, rerender } = render(<AgentLog />);

    const button = container.querySelector('.agent-log__terminate')!;
    expect(button).toHaveTextContent('Terminate Workflow');
    expect(button).not.toBeDisabled();

    // Simulate disconnect
    vi.mocked(useWebSocket).mockReturnValue({ send: mockSend, connected: false, hasConnectedOnce: true });
    rerender(<AgentLog />);

    expect(button).toHaveTextContent('Disconnected - Reconnecting...');
    expect(button).toBeDisabled();
  });

  it('does not render terminate button when status transitions to complete', () => {
    vi.mocked(useWebSocket).mockReturnValue({ send: mockSend, connected: true, hasConnectedOnce: true });
    seedStoreAct({ 'agent-1': makeAgentEntity('agent-1', [makeLogEntry('done')]) });

    const { container, rerender } = render(<AgentLog />);

    expect(container.querySelector('.agent-log__terminate')).toBeInTheDocument();

    // Status changes to complete
    act(() => {
      useWorkflowStore.getState().setStatus('complete');
    });
    rerender(<AgentLog />);

    expect(container.querySelector('.agent-log__terminate')).not.toBeInTheDocument();
  });

  it('does not render terminate button when status transitions to failed', () => {
    vi.mocked(useWebSocket).mockReturnValue({ send: mockSend, connected: true, hasConnectedOnce: true });
    seedStoreAct({ 'agent-1': makeAgentEntity('agent-1', [makeLogEntry('error')]) });

    const { container, rerender } = render(<AgentLog />);

    expect(container.querySelector('.agent-log__terminate')).toBeInTheDocument();

    // Status changes to failed
    act(() => {
      useWorkflowStore.getState().setStatus('failed');
    });
    rerender(<AgentLog />);

    expect(container.querySelector('.agent-log__terminate')).not.toBeInTheDocument();
  });
});
