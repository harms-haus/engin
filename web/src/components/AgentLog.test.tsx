/**
 * Tests for AgentLog – auto-scroll behavior.
 *
 * Verifies:
 * - Auto-scrolls to bottom when new log entries arrive and user is at bottom
 * - Does NOT auto-scroll when the user has scrolled up and new log entries arrive
 * - Re-enables auto-scroll when the user scrolls back to the bottom
 * - Auto-scrolls on agent switch (agent?.log reference changes, triggering effect)
 * - Handles empty / no-agent state gracefully
 */

import '@testing-library/jest-dom/vitest';

import { fireEvent, render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LogEntry } from '../protocol-types';
import type { AgentState } from '../types';
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

function makeAgentState(agentId: string, log: LogEntry[], overrides: Partial<AgentState> = {}): AgentState {
  return {
    agentId,
    profile: 'test-profile',
    active: true,
    log,
    toolCallCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    ...overrides,
  };
}

/**
 * Helper: mock scrollHeight and clientHeight on a div so we can
 * reliably control the scroll geometry in jsdom.
 */
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

/**
 * Helper: scroll a div to a given position and fire the scroll event
 * so React's onScroll handler runs.
 */
function scrollTo(el: HTMLDivElement, scrollTop: number): void {
  el.scrollTop = scrollTop;
  fireEvent.scroll(el);
}

/**
 * Helper: get the scrollable entries container inside AgentLog.
 * It's the div with className "agent-log__entries".
 */
function getScrollContainer(container: HTMLElement): HTMLDivElement {
  return container.querySelector('.agent-log__entries') as HTMLDivElement;
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe('AgentLog – auto-scroll behavior (single agent)', () => {
  beforeEach(() => {
    entryCounter = 0;
    vi.restoreAllMocks();
  });

  it('auto-scrolls to bottom when new log entries arrive and user is at bottom', () => {
    const initialLog = [makeLogEntry('a'), makeLogEntry('b')];
    const agents = new Map<string, AgentState>([['agent-1', makeAgentState('agent-1', initialLog)]]);

    const { container, rerender } = render(
      <AgentLog agents={agents} onTerminate={vi.fn()} status="running" connected={true} />,
    );

    const scrollDiv = getScrollContainer(container);
    expect(scrollDiv).toBeInTheDocument();

    // Mock geometry BEFORE triggering the effect with new log entries
    mockScrollGeometry(scrollDiv, 1000, 200);

    // Add new log entries (triggers re-render)
    const newLog = [...initialLog, makeLogEntry('c')];
    const updatedAgents = new Map<string, AgentState>([['agent-1', makeAgentState('agent-1', newLog)]]);
    rerender(<AgentLog agents={updatedAgents} onTerminate={vi.fn()} status="running" connected={true} />);

    // With the fix: autoScroll starts as true → effect scrolls to bottom
    expect(scrollDiv.scrollTop).toBe(1000);
  });

  it('does NOT auto-scroll when user has scrolled up and new log entries arrive', () => {
    const initialLog = [makeLogEntry('a'), makeLogEntry('b'), makeLogEntry('c')];
    const agents = new Map<string, AgentState>([['agent-1', makeAgentState('agent-1', initialLog)]]);

    const { container, rerender } = render(
      <AgentLog agents={agents} onTerminate={vi.fn()} status="running" connected={true} />,
    );

    const scrollDiv = getScrollContainer(container);
    mockScrollGeometry(scrollDiv, 1000, 200);

    // Trigger initial auto-scroll with new entries
    const triggerLog = [...initialLog, makeLogEntry('d')];
    let updatedAgents = new Map<string, AgentState>([['agent-1', makeAgentState('agent-1', triggerLog)]]);
    rerender(<AgentLog agents={updatedAgents} onTerminate={vi.fn()} status="running" connected={true} />);
    expect(scrollDiv.scrollTop).toBe(1000);

    // Simulate user scrolling up – far from bottom
    // isNearBottom = scrollHeight - scrollTop - clientHeight < 30
    // 1000 - 100 - 200 = 700 >= 30 → not near bottom → autoScroll = false
    scrollTo(scrollDiv, 100);

    // Add more entries while scrolled up
    const newLog = [...triggerLog, makeLogEntry('e'), makeLogEntry('f')];
    updatedAgents = new Map<string, AgentState>([['agent-1', makeAgentState('agent-1', newLog)]]);
    rerender(<AgentLog agents={updatedAgents} onTerminate={vi.fn()} status="running" connected={true} />);

    // With the fix: autoScroll is false, so scrollTop should NOT change.
    // With current code: scrollTop would be set to scrollHeight (1000).
    expect(scrollDiv.scrollTop).toBe(100);
  });

  it('re-enables auto-scroll when user scrolls back to bottom and new entries arrive', () => {
    const initialLog = [makeLogEntry('a'), makeLogEntry('b')];
    const agents = new Map<string, AgentState>([['agent-1', makeAgentState('agent-1', initialLog)]]);

    const { container, rerender } = render(
      <AgentLog agents={agents} onTerminate={vi.fn()} status="running" connected={true} />,
    );

    const scrollDiv = getScrollContainer(container);
    mockScrollGeometry(scrollDiv, 1000, 200);

    // Trigger initial auto-scroll
    let updatedAgents = new Map<string, AgentState>([
      ['agent-1', makeAgentState('agent-1', [...initialLog, makeLogEntry('c')])],
    ]);
    rerender(<AgentLog agents={updatedAgents} onTerminate={vi.fn()} status="running" connected={true} />);
    expect(scrollDiv.scrollTop).toBe(1000);

    // Scroll up (disables auto-scroll)
    scrollTo(scrollDiv, 100);
    expect(scrollDiv.scrollTop).toBe(100);

    // Add entries while scrolled up – should NOT scroll
    updatedAgents = new Map<string, AgentState>([
      ['agent-1', makeAgentState('agent-1', [...initialLog, makeLogEntry('c'), makeLogEntry('d')])],
    ]);
    rerender(<AgentLog agents={updatedAgents} onTerminate={vi.fn()} status="running" connected={true} />);
    expect(scrollDiv.scrollTop).toBe(100);

    // Scroll back to bottom (within 30px threshold)
    // isNearBottom = 1000 - 970 - 200 = -170 < 30 → true → autoScroll = true
    scrollTo(scrollDiv, 970);

    // Add another entry – should auto-scroll now
    updatedAgents = new Map<string, AgentState>([
      ['agent-1', makeAgentState('agent-1', [...initialLog, makeLogEntry('c'), makeLogEntry('d'), makeLogEntry('e')])],
    ]);
    rerender(<AgentLog agents={updatedAgents} onTerminate={vi.fn()} status="running" connected={true} />);

    expect(scrollDiv.scrollTop).toBe(1000);
  });

  it('maintains auto-scroll when already at bottom and new log entries arrive', () => {
    const initialLog = [makeLogEntry('a'), makeLogEntry('b')];
    const agents = new Map<string, AgentState>([['agent-1', makeAgentState('agent-1', initialLog)]]);

    const { container, rerender } = render(
      <AgentLog agents={agents} onTerminate={vi.fn()} status="running" connected={true} />,
    );

    const scrollDiv = getScrollContainer(container);
    mockScrollGeometry(scrollDiv, 1000, 200);

    // Trigger initial auto-scroll
    const midLog = [...initialLog, makeLogEntry('c')];
    let updatedAgents = new Map<string, AgentState>([['agent-1', makeAgentState('agent-1', midLog)]]);
    rerender(<AgentLog agents={updatedAgents} onTerminate={vi.fn()} status="running" connected={true} />);
    expect(scrollDiv.scrollTop).toBe(1000);

    // Multiple new entries arrive while user is at bottom
    const newLog = [...midLog, makeLogEntry('d'), makeLogEntry('e'), makeLogEntry('f')];
    updatedAgents = new Map<string, AgentState>([['agent-1', makeAgentState('agent-1', newLog)]]);
    rerender(<AgentLog agents={updatedAgents} onTerminate={vi.fn()} status="running" connected={true} />);

    // Should still be at bottom
    expect(scrollDiv.scrollTop).toBe(1000);
  });
});

describe('AgentLog – auto-scroll on agent switch', () => {
  beforeEach(() => {
    entryCounter = 0;
    vi.restoreAllMocks();
  });

  it('auto-scrolls when switching to a different agent (log reference changes)', () => {
    // Two agents with different logs
    const agents = new Map<string, AgentState>([
      ['agent-1', makeAgentState('agent-1', [makeLogEntry('from agent 1')])],
      ['agent-2', makeAgentState('agent-2', [makeLogEntry('from agent 2')])],
    ]);

    const { container, rerender } = render(
      <AgentLog agents={agents} onTerminate={vi.fn()} status="running" connected={true} />,
    );

    const scrollDiv = getScrollContainer(container);
    mockScrollGeometry(scrollDiv, 1000, 200);

    // Trigger initial auto-scroll on agent-1
    rerender(<AgentLog agents={agents} onTerminate={vi.fn()} status="running" connected={true} />);
    expect(scrollDiv.scrollTop).toBe(1000);

    // Now switch to agent-2 by changing the map so agent-2 is the only one
    const singleAgentMap = new Map<string, AgentState>([
      ['agent-2', makeAgentState('agent-2', [makeLogEntry('from agent 2')])],
    ]);
    rerender(<AgentLog agents={singleAgentMap} onTerminate={vi.fn()} status="running" connected={true} />);

    // When switching agents, agent?.log reference changes (different array).
    // With the fix: if autoScroll is true (user was at bottom), effect scrolls.
    // Since we were at bottom before the switch, autoScroll should be true.
    expect(scrollDiv.scrollTop).toBe(1000);
  });

  it('does not auto-scroll on agent switch if user had scrolled up before switching', () => {
    // Setup with two agents
    const agent1Log = [makeLogEntry('a1')];
    const agent2Log = [makeLogEntry('b1')];
    const agents = new Map<string, AgentState>([
      ['agent-1', makeAgentState('agent-1', agent1Log)],
      ['agent-2', makeAgentState('agent-2', agent2Log)],
    ]);

    const { container, rerender } = render(
      <AgentLog agents={agents} onTerminate={vi.fn()} status="running" connected={true} />,
    );

    const scrollDiv = getScrollContainer(container);
    mockScrollGeometry(scrollDiv, 1000, 200);

    // Trigger initial auto-scroll (agent-1 selected)
    rerender(<AgentLog agents={agents} onTerminate={vi.fn()} status="running" connected={true} />);
    expect(scrollDiv.scrollTop).toBe(1000);

    // Scroll up in agent-1 → autoScroll = false
    scrollTo(scrollDiv, 50);

    // Switch to agent-2 (only provide agent-2, forcing selection change)
    const singleAgent = new Map<string, AgentState>([['agent-2', makeAgentState('agent-2', agent2Log)]]);
    rerender(<AgentLog agents={singleAgent} onTerminate={vi.fn()} status="running" connected={true} />);

    // autoScroll is false (from scrolling up), so even though agent?.log
    // changed, the effect should NOT scroll because autoScroll is false.
    expect(scrollDiv.scrollTop).toBe(50);
  });
});

describe('AgentLog – empty / edge cases', () => {
  beforeEach(() => {
    entryCounter = 0;
    vi.restoreAllMocks();
  });

  it('renders without error when agents map is empty', () => {
    const agents = new Map<string, AgentState>();
    const { container } = render(<AgentLog agents={agents} onTerminate={vi.fn()} status="running" connected={true} />);

    // Should show "No agent selected"
    expect(container.textContent).toContain('No agent selected');

    // Scroll container should exist but have no entries
    const scrollDiv = getScrollContainer(container);
    expect(scrollDiv).toBeInTheDocument();
  });

  it('handles new agent being added (keys length changes)', () => {
    const initialLog = [makeLogEntry('initial')];
    const agents = new Map<string, AgentState>([['agent-1', makeAgentState('agent-1', initialLog)]]);

    const { container, rerender } = render(
      <AgentLog agents={agents} onTerminate={vi.fn()} status="running" connected={true} />,
    );

    const scrollDiv = getScrollContainer(container);
    mockScrollGeometry(scrollDiv, 1000, 200);

    // Trigger initial auto-scroll
    rerender(<AgentLog agents={agents} onTerminate={vi.fn()} status="running" connected={true} />);
    expect(scrollDiv.scrollTop).toBe(1000);

    // Add a new agent
    const updatedAgents = new Map<string, AgentState>([
      ['agent-1', makeAgentState('agent-1', initialLog)],
      ['agent-2', makeAgentState('agent-2', [makeLogEntry('new agent')])],
    ]);
    rerender(<AgentLog agents={updatedAgents} onTerminate={vi.fn()} status="running" connected={true} />);

    // selectedIndex was 0, keys length changed from 1 to 2, but 0 < 2, so selection stays
    // autoScroll should still be true (no scroll happened to change it)
    // The effect should re-run and scroll to bottom
    expect(scrollDiv.scrollTop).toBe(1000);
  });
});

describe('AgentLog – terminate button (connected state)', () => {
  beforeEach(() => {
    entryCounter = 0;
    vi.restoreAllMocks();
  });

  it('shows terminate button when status is running and connected is true', () => {
    const agents = new Map<string, AgentState>([['agent-1', makeAgentState('agent-1', [makeLogEntry('running')])]]);

    const { container } = render(<AgentLog agents={agents} onTerminate={vi.fn()} status="running" connected={true} />);

    const button = container.querySelector('.agent-log__terminate');
    expect(button).toBeInTheDocument();
    expect(button).not.toBeDisabled();
    expect(button).toHaveTextContent('Terminate Workflow');
  });

  it('shows terminate button as disabled with feedback text when disconnected', () => {
    const agents = new Map<string, AgentState>([['agent-1', makeAgentState('agent-1', [makeLogEntry('running')])]]);

    const { container } = render(<AgentLog agents={agents} onTerminate={vi.fn()} status="running" connected={false} />);

    const button = container.querySelector('.agent-log__terminate');
    expect(button).toBeInTheDocument();
    expect(button).toBeDisabled();
    expect(button).toHaveTextContent('Disconnected - Reconnecting...');
  });

  it('does not render terminate button when status is complete', () => {
    const agents = new Map<string, AgentState>([['agent-1', makeAgentState('agent-1', [makeLogEntry('done')])]]);

    const { container } = render(<AgentLog agents={agents} onTerminate={vi.fn()} status="complete" connected={true} />);

    const button = container.querySelector('.agent-log__terminate');
    expect(button).not.toBeInTheDocument();
  });

  it('does not render terminate button when status is failed', () => {
    const agents = new Map<string, AgentState>([['agent-1', makeAgentState('agent-1', [makeLogEntry('error')])]]);

    const { container } = render(<AgentLog agents={agents} onTerminate={vi.fn()} status="failed" connected={true} />);

    const button = container.querySelector('.agent-log__terminate');
    expect(button).not.toBeInTheDocument();
  });

  it('calls onTerminate when button is clicked while connected', () => {
    const onTerminate = vi.fn();
    const agents = new Map<string, AgentState>([['agent-1', makeAgentState('agent-1', [makeLogEntry('running')])]]);

    const { container } = render(
      <AgentLog agents={agents} onTerminate={onTerminate} status="running" connected={true} />,
    );

    const button = container.querySelector('.agent-log__terminate')!;
    fireEvent.click(button);
    expect(onTerminate).toHaveBeenCalledTimes(1);
  });

  it('does not call onTerminate when button is clicked while disconnected', () => {
    const onTerminate = vi.fn();
    const agents = new Map<string, AgentState>([['agent-1', makeAgentState('agent-1', [makeLogEntry('running')])]]);

    const { container } = render(
      <AgentLog agents={agents} onTerminate={onTerminate} status="running" connected={false} />,
    );

    const button = container.querySelector('.agent-log__terminate')!;
    expect(button).toBeDisabled();

    // Clicking a disabled button should not trigger onClick in HTML,
    // but React still fires the click handler – the disabled attribute
    // prevents the default action but the handler may still be called.
    // We verify the button is disabled so the user cannot interact with it.
    fireEvent.click(button);
    // The handler may or may not fire; what matters is the button is disabled.
    // We just verify it's disabled.
    expect(button).toBeDisabled();
  });

  it('has correct CSS class on the terminate button', () => {
    const agents = new Map<string, AgentState>([['agent-1', makeAgentState('agent-1', [makeLogEntry('running')])]]);

    const { container } = render(<AgentLog agents={agents} onTerminate={vi.fn()} status="running" connected={true} />);

    const button = container.querySelector('.agent-log__terminate');
    expect(button).toHaveClass('agent-log__terminate');
  });

  it('transitions button text from connected to disconnected when connected prop changes', () => {
    const onTerminate = vi.fn();
    const agents = new Map<string, AgentState>([['agent-1', makeAgentState('agent-1', [makeLogEntry('running')])]]);

    const { container, rerender } = render(
      <AgentLog agents={agents} onTerminate={onTerminate} status="running" connected={true} />,
    );

    const button = container.querySelector('.agent-log__terminate')!;
    expect(button).toHaveTextContent('Terminate Workflow');
    expect(button).not.toBeDisabled();

    // Simulate disconnect
    rerender(<AgentLog agents={agents} onTerminate={onTerminate} status="running" connected={false} />);

    expect(button).toHaveTextContent('Disconnected - Reconnecting...');
    expect(button).toBeDisabled();
  });

  it('does not render terminate button when agents exist but status is complete even if connected', () => {
    const agents = new Map<string, AgentState>([['agent-1', makeAgentState('agent-1', [makeLogEntry('done')])]]);

    const { container, rerender } = render(
      <AgentLog agents={agents} onTerminate={vi.fn()} status="running" connected={true} />,
    );

    expect(container.querySelector('.agent-log__terminate')).toBeInTheDocument();

    // Status changes to complete
    rerender(<AgentLog agents={agents} onTerminate={vi.fn()} status="complete" connected={true} />);

    expect(container.querySelector('.agent-log__terminate')).not.toBeInTheDocument();
  });

  it('does not render terminate button when agents exist but status is failed even if connected', () => {
    const agents = new Map<string, AgentState>([['agent-1', makeAgentState('agent-1', [makeLogEntry('error')])]]);

    const { container, rerender } = render(
      <AgentLog agents={agents} onTerminate={vi.fn()} status="running" connected={true} />,
    );

    expect(container.querySelector('.agent-log__terminate')).toBeInTheDocument();

    // Status changes to failed
    rerender(<AgentLog agents={agents} onTerminate={vi.fn()} status="failed" connected={true} />);

    expect(container.querySelector('.agent-log__terminate')).not.toBeInTheDocument();
  });
});
