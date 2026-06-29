/**
 * Tests for EventLog – workflow-level event line rendering.
 *
 * Verifies:
 * - Workflow-lifecycle events render their emoji lines (via formatWorkflowEventLine)
 * - Verbose events (tool_call_*, decision, turn_*, tasks_added, task_step_started)
 *   produce NO rendered lines
 * - Empty-state messages for pre-snapshot and post-snapshot-but-no-events
 * - Auto-scroll behavior (near bottom → auto-scroll, away → no scroll, etc.)
 *
 * The component self-subscribes to the store via useWorkflowEventLog().
 * Tests seed the store with EventRecord[] via applyEvents().
 */

import '@testing-library/jest-dom/vitest';

import { act, fireEvent, render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EventRecord } from '../protocol-types';
import { useWorkflowStore } from '../store/workflow-store';
import { EventLog } from './EventLog';

// ─── Constants ───────────────────────────────────────────────────────────────

const RUN_ID = 'run-1';

// ─── Helpers ───────────────────────────────────────────────────────────────

/** Create an EventRecord with sensible defaults. */
function mkEvent(
  seq: number,
  type: EventRecord['type'],
  data: Record<string, unknown> = {},
  meta: Partial<EventRecord['metadata']> = {},
): EventRecord {
  return {
    seq,
    type,
    data,
    metadata: { timestamp: `2025-01-01T00:00:${String(seq).padStart(2, '0')}Z`, ...meta },
  };
}

/** Seed the store via applyEvents so workflowEventLog is populated. */
function pushEvents(events: EventRecord[]): void {
  useWorkflowStore.getState().applyEvents(RUN_ID, events);
}

/** Push events wrapped in act() so React flushes the re-render. */
function pushEventsAct(events: EventRecord[]): void {
  act(() => {
    pushEvents(events);
  });
}

/** Seed an empty snapshot so hasSnapshot=true but workflowEventLog is empty. */
function seedEmptySnapshot(): void {
  useWorkflowStore.getState().applySnapshot(
    RUN_ID,
    {
      seq: 1,
      taskPrompt: '',
      phases: [],
      currentPhaseId: '',
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

describe('EventLog – workflow-level event rendering', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    resetStore();
  });

  it('renders workflow_started with emoji line', () => {
    pushEventsAct([mkEvent(1, 'workflow_started', { taskPrompt: 'build', resumed: false })]);

    const { container } = render(<EventLog />);
    expect(container.textContent).toContain('🚀 workflow started: "build" (resumed: false)');
  });

  it('renders phase_started with emoji line', () => {
    pushEventsAct([mkEvent(1, 'phase_started', { phase: 'scouting', round: 1 })]);

    const { container } = render(<EventLog />);
    expect(container.textContent).toContain('📦 phase started (round 1)');
  });

  it('renders task_started with emoji line', () => {
    pushEventsAct([mkEvent(1, 'task_started', { taskId: 't1', title: 'T' }, { taskId: 't1' })]);

    const { container } = render(<EventLog />);
    expect(container.textContent).toContain('📋 task started: "T"');
  });

  it('renders error with emoji line', () => {
    pushEventsAct([mkEvent(1, 'error', { error: 'crash' }, { agentId: 'a1', phaseId: 'planning' })]);

    const { container } = render(<EventLog />);
    expect(container.textContent).toContain('⚠️ error: crash');
  });

  it('renders phase_completed with emoji line', () => {
    pushEventsAct([mkEvent(1, 'phase_completed', { phase: 'plan', durationMs: 3000 })]);

    const { container } = render(<EventLog />);
    expect(container.textContent).toContain('✅ phase completed (3.0s)');
  });

  it('renders workflow_completed with emoji line', () => {
    pushEventsAct([mkEvent(1, 'workflow_completed', { totalDurationMs: 12500, sessionCount: 3 })]);

    const { container } = render(<EventLog />);
    expect(container.textContent).toContain('🎉 complete in 12.5s (3 sessions)');
  });

  it('renders workflow_failed with emoji line', () => {
    pushEventsAct([mkEvent(1, 'workflow_failed', { phase: 'exec', error: 'timeout' })]);

    const { container } = render(<EventLog />);
    expect(container.textContent).toContain('💥 failed: timeout');
  });

  it('renders session_started with emoji line', () => {
    pushEventsAct([mkEvent(1, 'session_started', { profile: 'coder' }, { agentId: 'a1' })]);

    const { container } = render(<EventLog />);
    expect(container.textContent).toContain('⏳ session started (coder)');
  });

  it('renders session_completed with emoji line', () => {
    pushEventsAct([mkEvent(1, 'session_completed', {}, { agentId: 'a1' })]);

    const { container } = render(<EventLog />);
    expect(container.textContent).toContain('✅ session complete');
  });

  it('renders task_completed with emoji line', () => {
    pushEventsAct([mkEvent(1, 'task_completed', { taskId: 't1' }, { taskId: 't1' })]);

    const { container } = render(<EventLog />);
    expect(container.textContent).toContain('✅ task complete');
  });

  it('renders task_rejected with emoji line', () => {
    pushEventsAct([mkEvent(1, 'task_rejected', { taskId: 't1', reason: 'stale' }, { taskId: 't1' })]);

    const { container } = render(<EventLog />);
    expect(container.textContent).toContain('❌ task rejected: stale');
  });

  it('renders sidebar_updated with emoji line when title is set', () => {
    pushEventsAct([mkEvent(1, 'sidebar_updated', { title: 'My App', indicator: 'green' })]);

    const { container } = render(<EventLog />);
    expect(container.textContent).toContain('📌 My App');
  });

  it('does NOT render sidebar_updated when title is empty', () => {
    pushEventsAct([mkEvent(1, 'sidebar_updated', { indicator: 'green' })]);

    const { container } = render(<EventLog />);
    // sidebar_updated with no title returns null → no rendered line
    expect(container.textContent).toContain('Waiting for activity…');
  });

  it('does NOT render verbose events (tool_call_started, decision, turn_ended, turn_started)', () => {
    pushEventsAct([
      mkEvent(1, 'workflow_started', { taskPrompt: 'hello' }),
      mkEvent(2, 'tool_call_started', { toolName: 'read' }, { agentId: 'a1' }),
      mkEvent(3, 'decision', { decision: 'proceed' }, { agentId: 'a1' }),
      mkEvent(4, 'turn_ended', { tokens: { input: 10, output: 5 } }, { agentId: 'a1' }),
      mkEvent(7, 'turn_started', {}, { agentId: 'a1' }),
    ]);

    const { container } = render(<EventLog />);

    const lines = container.querySelectorAll('.event-log__entry');
    // Only workflow_started should render — all verbose events return null
    expect(lines).toHaveLength(1);
    expect(lines[0].textContent).toContain('🚀 workflow started: "hello"');
  });

  it('renders multiple lifecycle events in order', () => {
    pushEventsAct([
      mkEvent(1, 'workflow_started', { taskPrompt: 'build' }),
      mkEvent(2, 'phase_started', { phase: 'plan', round: 1 }),
      mkEvent(3, 'phase_completed', { phase: 'plan', durationMs: 2000 }),
    ]);

    const { container } = render(<EventLog />);
    const text = container.textContent ?? '';
    const idx1 = text.indexOf('🚀');
    const idx2 = text.indexOf('📦');
    const idx3 = text.indexOf('✅ phase completed');
    expect(idx1).toBeLessThan(idx2);
    expect(idx2).toBeLessThan(idx3);
  });
});

describe('EventLog – empty state', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    resetStore();
  });

  it('shows "Connecting to workflow…" when no snapshot has arrived', () => {
    const { container } = render(<EventLog />);
    expect(container.textContent).toContain('Connecting to workflow…');
  });

  it('shows "Waiting for activity…" when snapshot arrived but no events', () => {
    act(() => {
      seedEmptySnapshot();
    });

    const { container } = render(<EventLog />);
    expect(container.textContent).toContain('Waiting for activity…');
  });

  it('does not show empty state when events exist', () => {
    pushEventsAct([mkEvent(1, 'workflow_started', { taskPrompt: 'hello' })]);

    const { container } = render(<EventLog />);
    expect(container.textContent).not.toContain('Waiting for activity…');
    expect(container.textContent).not.toContain('Connecting to workflow…');
    expect(container.textContent).toContain('🚀');
  });
});

describe('EventLog – auto-scroll behavior', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    resetStore();
  });

  it('auto-scrolls to bottom when new events arrive and user is at bottom', () => {
    // Seed initial events so the store has seq > 0
    pushEventsAct([
      mkEvent(1, 'workflow_started', { taskPrompt: 'a' }),
      mkEvent(2, 'phase_started', { phase: 'p1', round: 1 }),
    ]);

    const { container } = render(<EventLog />);

    const scrollDiv = container.querySelector('.event-log') as HTMLDivElement;
    expect(scrollDiv).toBeInTheDocument();

    // Mock geometry BEFORE triggering the effect with new events
    mockScrollGeometry(scrollDiv, 1000, 200);

    // Add new events — wrapped in act so React flushes the re-render
    pushEventsAct([mkEvent(3, 'phase_completed', { phase: 'p1', durationMs: 1000 })]);

    expect(scrollDiv.scrollTop).toBe(1000);
  });

  it('does NOT auto-scroll when user has scrolled away from the bottom', () => {
    pushEventsAct([
      mkEvent(1, 'workflow_started', { taskPrompt: 'a' }),
      mkEvent(2, 'phase_started', { phase: 'p1', round: 1 }),
    ]);

    const { container } = render(<EventLog />);

    const scrollDiv = container.querySelector('.event-log') as HTMLDivElement;
    mockScrollGeometry(scrollDiv, 1000, 200);

    // Trigger initial auto-scroll with new events
    pushEventsAct([mkEvent(3, 'phase_completed', { phase: 'p1', durationMs: 1000 })]);
    expect(scrollDiv.scrollTop).toBe(1000);

    // Simulate user scrolling up – far from bottom
    scrollTo(scrollDiv, 100);

    // Add more events while scrolled up
    pushEventsAct([mkEvent(4, 'phase_started', { phase: 'p2', round: 2 })]);

    // autoScroll is false, so scrollTop should NOT change.
    expect(scrollDiv.scrollTop).toBe(100);
  });

  it('re-enables auto-scroll when user scrolls back to the bottom', () => {
    pushEventsAct([mkEvent(1, 'workflow_started', { taskPrompt: 'a' })]);

    const { container } = render(<EventLog />);

    const scrollDiv = container.querySelector('.event-log') as HTMLDivElement;
    mockScrollGeometry(scrollDiv, 1000, 200);

    // Trigger initial auto-scroll
    pushEventsAct([mkEvent(2, 'phase_started', { phase: 'p1', round: 1 })]);
    expect(scrollDiv.scrollTop).toBe(1000);

    // User scrolls up (disables auto-scroll)
    scrollTo(scrollDiv, 100);
    expect(scrollDiv.scrollTop).toBe(100);

    // Add events while scrolled up – should NOT scroll
    pushEventsAct([mkEvent(3, 'phase_completed', { phase: 'p1', durationMs: 500 })]);
    expect(scrollDiv.scrollTop).toBe(100);

    // Scroll back to bottom (within 30px threshold)
    scrollTo(scrollDiv, 970);

    // Add another event – should auto-scroll now
    pushEventsAct([mkEvent(4, 'phase_started', { phase: 'p2', round: 2 })]);
    expect(scrollDiv.scrollTop).toBe(1000);
  });

  it('maintains auto-scroll when new events arrive and user is already at bottom', () => {
    pushEventsAct([mkEvent(1, 'workflow_started', { taskPrompt: 'a' })]);

    const { container } = render(<EventLog />);

    const scrollDiv = container.querySelector('.event-log') as HTMLDivElement;
    mockScrollGeometry(scrollDiv, 1000, 200);

    // Trigger initial auto-scroll
    pushEventsAct([mkEvent(2, 'phase_started', { phase: 'p1', round: 1 })]);
    expect(scrollDiv.scrollTop).toBe(1000);

    // Multiple new events arrive while user is at bottom
    pushEventsAct([
      mkEvent(3, 'phase_completed', { phase: 'p1', durationMs: 500 }),
      mkEvent(4, 'phase_started', { phase: 'p2', round: 2 }),
      mkEvent(5, 'phase_completed', { phase: 'p2', durationMs: 300 }),
    ]);

    // Should still be at bottom (auto-scrolled each time)
    expect(scrollDiv.scrollTop).toBe(1000);
  });

  it('does not auto-scroll when user is at the threshold boundary (30px away)', () => {
    pushEventsAct([mkEvent(1, 'workflow_started', { taskPrompt: 'a' })]);

    const { container } = render(<EventLog />);

    const scrollDiv = container.querySelector('.event-log') as HTMLDivElement;
    mockScrollGeometry(scrollDiv, 1000, 200);

    // Trigger initial auto-scroll
    pushEventsAct([mkEvent(2, 'phase_started', { phase: 'p1', round: 1 })]);
    expect(scrollDiv.scrollTop).toBe(1000);

    // Scroll to exactly 770 → isNearBottom = 1000 - 770 - 200 = 30 → not < 30 → false
    scrollTo(scrollDiv, 770);

    // Add new events
    pushEventsAct([mkEvent(3, 'phase_completed', { phase: 'p1', durationMs: 500 })]);

    // Should NOT auto-scroll because user is exactly at the threshold boundary
    expect(scrollDiv.scrollTop).toBe(770);
  });

  it('auto-scrolls when user is just within the threshold (29px away)', () => {
    pushEventsAct([mkEvent(1, 'workflow_started', { taskPrompt: 'a' })]);

    const { container } = render(<EventLog />);

    const scrollDiv = container.querySelector('.event-log') as HTMLDivElement;
    mockScrollGeometry(scrollDiv, 1000, 200);

    // Trigger initial auto-scroll
    pushEventsAct([mkEvent(2, 'phase_started', { phase: 'p1', round: 1 })]);
    expect(scrollDiv.scrollTop).toBe(1000);

    // Scroll to 771 → isNearBottom = 1000 - 771 - 200 = 29 < 30 → true
    scrollTo(scrollDiv, 771);

    // Add new events
    pushEventsAct([mkEvent(3, 'phase_completed', { phase: 'p1', durationMs: 500 })]);

    // Should auto-scroll because user is within the 30px threshold
    expect(scrollDiv.scrollTop).toBe(1000);
  });
});
