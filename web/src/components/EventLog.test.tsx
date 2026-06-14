/**
 * Tests for EventLog – auto-scroll behavior.
 *
 * Verifies:
 * - Auto-scrolls to bottom when new entries arrive and user is near bottom
 * - Does NOT auto-scroll when the user has scrolled up
 * - Re-enables auto-scroll when the user scrolls back to the bottom
 * - Multiple new entries maintain auto-scroll position when at bottom
 * - Boundary tests for the 30px near-bottom threshold
 *
 * The component now self-subscribes to the store via useRecentLogEntries().
 * Tests seed the store with agent log entries directly.
 */

import '@testing-library/jest-dom/vitest';

import { act, fireEvent, render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEntity, LogEntry } from '../protocol-types';
import { useWorkflowStore } from '../store/workflow-store';
import { EventLog } from './EventLog';

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

function makeAgentEntity(agentId: string, log: LogEntry[]): AgentEntity {
  return {
    uid: agentId,
    agentId,
    profile: 'test',
    phase: '',
    active: true,
    log,
    toolCallCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    taskTitle: '',
  };
}

/** Seed the store with a single agent holding the given log entries. */
function seedStore(logs: LogEntry[]): void {
  useWorkflowStore.getState().applySnapshot(
    {
      seq: 1,
      taskPrompt: '',
      currentPhase: '',
      completedPhases: [],
      tasks: {},
      agents: { 'agent-1': makeAgentEntity('agent-1', logs) },
      sidebar: { title: '', indicator: '' },
      status: 'running',
      stats: { totalTokens: 0, agentCount: 1 },
    },
    1,
  );
}

/** Seed the store wrapped in act() so React flushes the re-render. */
function seedStoreAct(logs: LogEntry[]): void {
  act(() => {
    seedStore(logs);
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
  });
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe('EventLog – auto-scroll behavior', () => {
  beforeEach(() => {
    entryCounter = 0;
    vi.restoreAllMocks();
    resetStore();
  });

  it('auto-scrolls to bottom when new entries arrive and user is at bottom', () => {
    const entries = [makeLogEntry('a'), makeLogEntry('b'), makeLogEntry('c')];
    seedStoreAct(entries);

    const { container } = render(<EventLog />);

    const scrollDiv = container.querySelector('.event-log') as HTMLDivElement;
    expect(scrollDiv).toBeInTheDocument();

    // Mock geometry BEFORE triggering the effect with new entries
    mockScrollGeometry(scrollDiv, 1000, 200);

    // Add a new entry — wrapped in act so React flushes the re-render
    seedStoreAct([...entries, makeLogEntry('d')]);

    expect(scrollDiv.scrollTop).toBe(1000);
  });

  it('does NOT auto-scroll when user has scrolled away from the bottom', () => {
    const entries = [makeLogEntry('a'), makeLogEntry('b'), makeLogEntry('c')];
    seedStoreAct(entries);

    const { container } = render(<EventLog />);

    const scrollDiv = container.querySelector('.event-log') as HTMLDivElement;
    mockScrollGeometry(scrollDiv, 1000, 200);

    // Trigger initial auto-scroll with new entries
    seedStoreAct([...entries, makeLogEntry('d')]);
    expect(scrollDiv.scrollTop).toBe(1000);

    // Simulate user scrolling up – far from bottom
    scrollTo(scrollDiv, 100);

    // Add another entry while scrolled up
    seedStoreAct([makeLogEntry('a'), makeLogEntry('b'), makeLogEntry('c'), makeLogEntry('d'), makeLogEntry('e')]);

    // autoScroll is false, so scrollTop should NOT change.
    expect(scrollDiv.scrollTop).toBe(100);
  });

  it('re-enables auto-scroll when user scrolls back to the bottom', () => {
    const entries = [makeLogEntry('a'), makeLogEntry('b')];
    seedStoreAct(entries);

    const { container } = render(<EventLog />);

    const scrollDiv = container.querySelector('.event-log') as HTMLDivElement;
    mockScrollGeometry(scrollDiv, 1000, 200);

    // Trigger initial auto-scroll
    seedStoreAct([...entries, makeLogEntry('c')]);
    expect(scrollDiv.scrollTop).toBe(1000);

    // User scrolls up (disables auto-scroll)
    scrollTo(scrollDiv, 100);
    expect(scrollDiv.scrollTop).toBe(100);

    // Add entries while scrolled up – should NOT scroll
    seedStoreAct([makeLogEntry('a'), makeLogEntry('b'), makeLogEntry('c'), makeLogEntry('d')]);
    expect(scrollDiv.scrollTop).toBe(100);

    // Scroll back to bottom (within 30px threshold)
    scrollTo(scrollDiv, 970);

    // Add another entry – should auto-scroll now
    seedStoreAct([makeLogEntry('a'), makeLogEntry('b'), makeLogEntry('c'), makeLogEntry('d'), makeLogEntry('e')]);
    expect(scrollDiv.scrollTop).toBe(1000);
  });

  it('maintains auto-scroll when new entries arrive and user is already at bottom', () => {
    const entries = [makeLogEntry('a'), makeLogEntry('b')];
    seedStoreAct(entries);

    const { container } = render(<EventLog />);

    const scrollDiv = container.querySelector('.event-log') as HTMLDivElement;
    mockScrollGeometry(scrollDiv, 1000, 200);

    // Trigger initial auto-scroll
    seedStoreAct([...entries, makeLogEntry('c')]);
    expect(scrollDiv.scrollTop).toBe(1000);

    // User is at bottom; multiple new entries arrive
    seedStoreAct([
      makeLogEntry('a'),
      makeLogEntry('b'),
      makeLogEntry('c'),
      makeLogEntry('d'),
      makeLogEntry('e'),
      makeLogEntry('f'),
    ]);

    // Should still be at bottom (auto-scrolled each time)
    expect(scrollDiv.scrollTop).toBe(1000);
  });

  it('does not auto-scroll when user is at the threshold boundary (30px away)', () => {
    const entries = [makeLogEntry('a'), makeLogEntry('b')];
    seedStoreAct(entries);

    const { container } = render(<EventLog />);

    const scrollDiv = container.querySelector('.event-log') as HTMLDivElement;
    mockScrollGeometry(scrollDiv, 1000, 200);

    // Trigger initial auto-scroll
    seedStoreAct([...entries, makeLogEntry('c')]);
    expect(scrollDiv.scrollTop).toBe(1000);

    // Scroll to exactly 770 → isNearBottom = 1000 - 770 - 200 = 30 → not < 30 → false
    scrollTo(scrollDiv, 770);

    // Add new entries
    seedStoreAct([makeLogEntry('a'), makeLogEntry('b'), makeLogEntry('c'), makeLogEntry('d')]);

    // Should NOT auto-scroll because user is exactly at the threshold boundary
    expect(scrollDiv.scrollTop).toBe(770);
  });

  it('auto-scrolls when user is just within the threshold (29px away)', () => {
    const entries = [makeLogEntry('a'), makeLogEntry('b')];
    seedStoreAct(entries);

    const { container } = render(<EventLog />);

    const scrollDiv = container.querySelector('.event-log') as HTMLDivElement;
    mockScrollGeometry(scrollDiv, 1000, 200);

    // Trigger initial auto-scroll
    seedStoreAct([...entries, makeLogEntry('c')]);
    expect(scrollDiv.scrollTop).toBe(1000);

    // Scroll to 771 → isNearBottom = 1000 - 771 - 200 = 29 < 30 → true
    scrollTo(scrollDiv, 771);

    // Add new entries
    seedStoreAct([makeLogEntry('a'), makeLogEntry('b'), makeLogEntry('c'), makeLogEntry('d')]);

    // Should auto-scroll because user is within the 30px threshold
    expect(scrollDiv.scrollTop).toBe(1000);
  });
});

describe('EventLog – empty state', () => {
  beforeEach(() => {
    entryCounter = 0;
    vi.restoreAllMocks();
    resetStore();
  });

  it('shows "Connecting to workflow…" when no snapshot has arrived', () => {
    // Store is in initial state (seq=0 → no snapshot)
    const { container } = render(<EventLog />);
    expect(container.textContent).toContain('Connecting to workflow…');
  });

  it('shows "Waiting for activity…" when snapshot arrived but no entries', () => {
    // Seed an empty snapshot with seq>0
    seedStoreAct([]);

    const { container } = render(<EventLog />);
    expect(container.textContent).toContain('Waiting for activity…');
  });

  it('does not show empty state when entries exist', () => {
    seedStoreAct([makeLogEntry('hello')]);

    const { container } = render(<EventLog />);
    expect(container.textContent).not.toContain('Waiting for activity…');
    expect(container.textContent).not.toContain('Connecting to workflow…');
    expect(container.textContent).toContain('hello');
  });
});

describe('EventLog – entry-type CSS and prefixes', () => {
  beforeEach(() => {
    entryCounter = 0;
    vi.restoreAllMocks();
    resetStore();
  });

  it('applies error modifier class and [ERROR] prefix to error entries', () => {
    seedStoreAct([makeLogEntry('boom', 'error')]);

    const { container } = render(<EventLog />);

    const entry = container.querySelector('.event-log__entry');
    expect(entry).toHaveClass('event-log__entry--error');
    expect(entry?.textContent).toContain('[ERROR]');
    expect(entry?.textContent).toContain('boom');
  });

  it('applies decision modifier class and [DECISION] prefix', () => {
    seedStoreAct([makeLogEntry('proceed', 'decision')]);

    const { container } = render(<EventLog />);

    const entry = container.querySelector('.event-log__entry');
    expect(entry).toHaveClass('event-log__entry--decision');
    expect(entry?.textContent).toContain('[DECISION]');
  });

  it('applies tool modifier class and [TOOL] prefix for tool_call_start', () => {
    seedStoreAct([makeLogEntry('read', 'tool_call_start')]);

    const { container } = render(<EventLog />);

    const entry = container.querySelector('.event-log__entry');
    expect(entry).toHaveClass('event-log__entry--tool');
    expect(entry?.textContent).toContain('[TOOL]');
  });

  it('hides tool_call_end entries from the rendered log', () => {
    seedStoreAct([makeLogEntry('read', 'tool_call_end')]);

    const { container } = render(<EventLog />);

    // tool_call_end is a redundant completion marker (the start entry already
    // shows the call); it stays in the store but is not rendered.
    const toolEntries = container.querySelectorAll('.event-log__entry--tool');
    expect(toolEntries).toHaveLength(0);
  });

  it('applies thinking modifier class and [THINKING] prefix', () => {
    seedStoreAct([makeLogEntry('hmm', 'thinking')]);

    const { container } = render(<EventLog />);

    const entry = container.querySelector('.event-log__entry');
    expect(entry).toHaveClass('event-log__entry--thinking');
    expect(entry?.textContent).toContain('[THINKING]');
  });

  it('does not add a prefix to plain text entries', () => {
    seedStoreAct([makeLogEntry('just text', 'text')]);

    const { container } = render(<EventLog />);

    const entry = container.querySelector('.event-log__entry');
    expect(entry?.textContent).toBe('just text');
  });
});
