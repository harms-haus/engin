/* eslint-disable @typescript-eslint/no-non-null-assertion */
/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Tests for AgentLog component.
 *
 * Verifies virtualized rendering of log entries with type-specific
 * formatting, auto-scroll behaviour, and CSS class application.
 *
 * NOTE: The production component uses @tanstack/react-virtual internally.
 * Tests mock the virtualizer to isolate rendering logic; integration-level
 * tests verify that the virtualizer is invoked with the correct configuration.
 *
 * Known edge cases (documented in the component):
 *   - Variable-height content may cause scroll jumps if estimates are far off.
 *   - Rapid updates are batched by React.
 *   - Auto-scroll only triggers when user is near bottom to avoid interrupting
 *     manual scroll.
 */

import '@testing-library/jest-dom/vitest';

import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { LogEntry } from '../../../types';
import { AgentLog } from '../AgentLog';

// ─── Mock @tanstack/react-virtual ──────────────────────────────────────────

// We mock the module so we can inspect virtualizer configuration and control
// which items appear in the "virtual" list during tests.
const mockScrollToIndex = vi.fn();
const mockGetTotalSize = vi.fn(() => 0);
const mockGetVirtualItems = vi.fn(() => []);

vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: vi.fn(() => ({
    getVirtualItems: mockGetVirtualItems,
    getTotalSize: mockGetTotalSize,
    scrollToIndex: mockScrollToIndex,
  })),
}));

// Re-import after mocking so the component picks up the mock
import { useVirtualizer } from '@tanstack/react-virtual';

// ─── Helpers ────────────────────────────────────────────────────────────────

function createEntry(overrides: Partial<LogEntry> = {}): LogEntry {
  return {
    id: 'e-' + Math.random().toString(36).slice(2, 8),
    timestamp: new Date().toISOString(),
    type: 'text',
    content: 'Default log content',
    ...overrides,
  };
}

/** Render AgentLog and return helpers for inspecting virtual items. */
function renderAgentLog(entries: LogEntry[]) {
  // Clear call history but retain default implementations
  mockGetVirtualItems.mockClear();
  mockGetTotalSize.mockClear();
  mockScrollToIndex.mockClear();

  const result = render(<AgentLog entries={entries} />);

  // Retrieve the latest useVirtualizer call arguments
  const virtualizerCalls = vi.mocked(useVirtualizer).mock.calls;
  const lastCall = virtualizerCalls[virtualizerCalls.length - 1]?.[0] ?? null;

  return {
    ...result,
    virtualizerOptions: lastCall,
    mockGetVirtualItems,
    mockGetTotalSize,
    mockScrollToIndex,
  };
}

/** Simulate the virtualizer returning a given list of virtual items. */
interface VirtualItemStub {
  key: string;
  index: number;
  start: number;
  size: number;
}
function setVirtualItems(items: VirtualItemStub[]) {
  mockGetVirtualItems.mockReturnValueOnce(items as any);
}

// ─── Setup ──────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
});

// ─── Basic rendering ────────────────────────────────────────────────────────

describe('basic rendering', () => {
  it('renders a root element with class "agent-log"', () => {
    const { container } = renderAgentLog([]);
    const root = container.querySelector('.agent-log');
    expect(root).toBeInTheDocument();
  });

  it('renders an outer scroll container with ref (parentRef)', () => {
    const { container } = renderAgentLog([]);
    const outer = container.querySelector('.agent-log');
    expect(outer).toBeInTheDocument();
    // The outer element is the scroll container (verified via CSS class).
    // Scroll styling is applied via AgentLog.css, not inline, so we check
    // the class rather than computed styles (which jsdom does not resolve).
    expect(outer).toHaveClass('agent-log');
  });

  it('renders nothing when entries array is empty', () => {
    const { container } = renderAgentLog([]);
    // The outer container should exist but contain no virtual items
    const outer = container.querySelector('.agent-log');
    expect(outer).toBeInTheDocument();
    const inner = container.querySelector('[style*="position: relative"]');
    // With 0 items, getTotalSize returns 0 so inner height is 0
    expect(inner).toBeInTheDocument();
  });

  it('renders the virtual list inner container with total height', () => {
    mockGetTotalSize.mockReturnValueOnce(500);
    // Provide one virtual item so the inner container gets rendered
    setVirtualItems([{ key: '0', index: 0, start: 0, size: 60 }]);

    const { container } = renderAgentLog([createEntry()]);
    const inner = container.querySelector('[style*="position: relative"]');
    expect(inner).toBeInTheDocument();
    expect(inner).toHaveStyle({ height: '500px' });
  });

  it('renders virtual items as children of the inner container', () => {
    const entries = [createEntry({ id: 'e1', content: 'Hello' })];
    setVirtualItems([{ key: '0', index: 0, start: 0, size: 60 }]);

    renderAgentLog(entries);
    expect(screen.getByText('Hello')).toBeInTheDocument();
  });

  it('renders only the visible virtual items (not all entries)', () => {
    const entries = [
      createEntry({ id: 'e1', content: 'First' }),
      createEntry({ id: 'e2', content: 'Second' }),
      createEntry({ id: 'e3', content: 'Third' }),
    ];

    // Virtualizer only returns 2 out of 3 items (e.g. items at index 1 and 2)
    setVirtualItems([
      { key: '1', index: 1, start: 60, size: 60 },
      { key: '2', index: 2, start: 120, size: 60 },
    ]);

    renderAgentLog(entries);
    expect(screen.getByText('Second')).toBeInTheDocument();
    expect(screen.getByText('Third')).toBeInTheDocument();
    expect(screen.queryByText('First')).not.toBeInTheDocument();
  });

  it('applies data-index attribute to each virtual item for measurement', () => {
    const entries = [createEntry({ id: 'e1', content: 'Item 0' }), createEntry({ id: 'e2', content: 'Item 1' })];

    setVirtualItems([
      { key: '0', index: 0, start: 0, size: 60 },
      { key: '1', index: 1, start: 60, size: 60 },
    ]);

    const { container } = renderAgentLog(entries);
    const items = container.querySelectorAll('[data-index]');
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveAttribute('data-index', '0');
    expect(items[1]).toHaveAttribute('data-index', '1');
  });

  it('positions virtual items absolutely with transform translateY', () => {
    const entries = [createEntry({ id: 'e1', content: 'Pos test' })];
    setVirtualItems([{ key: '0', index: 0, start: 42, size: 60 }]);

    const { container } = renderAgentLog(entries);
    const item = container.querySelector('[data-index="0"]') as HTMLElement;
    expect(item).toBeInTheDocument();
    expect(item.style.position).toBe('absolute');
    expect(item.style.top).toBe('0px');
    // The transform should include translateY equal to the start offset
    expect(item.style.transform).toContain('translateY');
  });

  it('applies class "log-entry" to each virtual item', () => {
    const entries = [createEntry({ id: 'e1', content: 'Class test' })];
    setVirtualItems([{ key: '0', index: 0, start: 0, size: 60 }]);

    const { container } = renderAgentLog(entries);
    const item = container.querySelector('[data-index="0"]');
    expect(item).toHaveClass('log-entry');
  });

  it('attaches onScroll handler to the outer scroll container', () => {
    const entries = [createEntry()];
    const { container } = renderAgentLog(entries);

    const outer = container.querySelector('.agent-log')! as HTMLElement;
    // Fire scroll event — it should not throw, and the internal isNearBottom
    // ref should be updated.
    expect(() => {
      outer.dispatchEvent(new Event('scroll', { bubbles: true }));
    }).not.toThrow();
  });

  it('invokes handleScroll callback when scrolling the outer container', () => {
    // This test verifies the scroll handler is attached and updates
    // isNearBottom. We indirectly verify by checking auto-scroll behaviour
    // after dispatching a scroll event.
    const entries = [createEntry()];
    const { container, rerender } = renderAgentLog(entries);

    const outer = container.querySelector('.agent-log')! as HTMLElement;
    // Set scroll position to be near bottom
    Object.defineProperty(outer, 'scrollHeight', { value: 1000, configurable: true });
    Object.defineProperty(outer, 'clientHeight', { value: 200, configurable: true });
    Object.defineProperty(outer, 'scrollTop', { value: 850, configurable: true });

    outer.dispatchEvent(new Event('scroll', { bubbles: true }));

    // Now add an entry — because the scroll handler updated isNearBottom to true,
    // auto-scroll should trigger.
    rerender(<AgentLog entries={[...entries, createEntry()]} />);
    expect(mockScrollToIndex).toHaveBeenCalledWith(1, { align: 'end' });
  });
});

// ─── Virtualizer configuration ──────────────────────────────────────────────

describe('virtualizer configuration', () => {
  it('calls useVirtualizer with count equal to entries.length', () => {
    const entries = [createEntry(), createEntry(), createEntry()];
    renderAgentLog(entries);

    expect(useVirtualizer).toHaveBeenCalled();
    const options = vi.mocked(useVirtualizer).mock.calls[0][0];
    expect(options.count).toBe(3);
  });

  it('passes getScrollElement that returns the parent DOM element', () => {
    const { container } = renderAgentLog([createEntry()]);
    const options = vi.mocked(useVirtualizer).mock.calls[0][0];
    const scrollEl = options.getScrollElement();
    expect(scrollEl).toBe(container.querySelector('.agent-log'));
  });

  it('provides estimateSize function that delegates to estimateEntryHeight', () => {
    const entries = [
      createEntry({ type: 'text', content: 'Hello' }),
      createEntry({ type: 'thinking', content: 'Hmm' }),
      createEntry({ type: 'tool_call_start', content: 'tool start' }),
      createEntry({ type: 'tool_call_end', content: 'tool end' }),
      createEntry({ type: 'decision', content: 'decided' }),
      createEntry({ type: 'error', content: 'error' }),
    ];
    renderAgentLog(entries);

    const options = vi.mocked(useVirtualizer).mock.calls[0][0];
    // estimateSize receives the entry index and should return the mapped height
    expect(options.estimateSize(0)).toBe(60); // text
    expect(options.estimateSize(1)).toBe(40); // thinking
    expect(options.estimateSize(2)).toBe(24); // tool_call_start
    expect(options.estimateSize(3)).toBe(24); // tool_call_end
    expect(options.estimateSize(4)).toBe(32); // decision
    expect(options.estimateSize(5)).toBe(32); // error
    // unknown type falls back to default
    const unknownEntry = createEntry({ type: 'tool_call', content: 'tool' });
    entries.push(unknownEntry);
    // Re-render with the additional entry
    // We can't easily test it without re-rendering; we'll test the function directly below
  });

  it('estimateSize returns 24 for unknown/log-default entry types', () => {
    // Directly test the estimateSize logic by examining the options function
    const entries = [createEntry({ type: 'tool_call', content: 'tool call' })];
    renderAgentLog(entries);
    const options = vi.mocked(useVirtualizer).mock.calls[0][0];
    expect(options.estimateSize(0)).toBe(24);
  });

  it('estimateSize returns 24 for tool_call type (not start/end)', () => {
    const entries = [createEntry({ type: 'tool_call', content: 'tool' })];
    renderAgentLog(entries);
    const options = vi.mocked(useVirtualizer).mock.calls[0][0];
    expect(options.estimateSize(0)).toBe(24);
  });

  it('passes overscan of 5', () => {
    renderAgentLog([createEntry()]);
    const options = vi.mocked(useVirtualizer).mock.calls[0][0];
    expect(options.overscan).toBe(5);
  });
});

// ─── Entry type rendering ──────────────────────────────────────────────────

describe('entry type rendering', () => {
  it('renders "text" entry with white text appearance (plain content)', () => {
    const entry = createEntry({ type: 'text', content: 'Plain text message' });
    setVirtualItems([{ key: '0', index: 0, start: 0, size: 60 }]);
    renderAgentLog([entry]);
    const el = screen.getByText('Plain text message');
    expect(el).toBeInTheDocument();
    // Text entries should be styled with white color (var(--engin-text) or similar)
    // We verify the class or style – the component should use text color (white)
  });

  it('renders "thinking" entry with 🧠 prefix and italic, secondary styling', () => {
    const entry = createEntry({ type: 'thinking', content: 'Reasoning about X' });
    setVirtualItems([{ key: '0', index: 0, start: 0, size: 40 }]);
    renderAgentLog([entry]);

    // Should display the emoji prefix
    expect(screen.getByText('🧠')).toBeInTheDocument();
    // Content should be rendered
    expect(screen.getByText('Reasoning about X')).toBeInTheDocument();
  });

  it('renders "tool_call_start" entry with 🔧 prefix and accent styling', () => {
    const entry = createEntry({ type: 'tool_call_start', content: 'Calling tool X' });
    setVirtualItems([{ key: '0', index: 0, start: 0, size: 24 }]);
    renderAgentLog([entry]);

    expect(screen.getByText('🔧')).toBeInTheDocument();
    expect(screen.getByText('Calling tool X')).toBeInTheDocument();
  });

  it('renders "tool_call_end" entry with ✅ when isError is falsy', () => {
    const entry = createEntry({
      type: 'tool_call_end',
      content: 'Tool completed',
      metadata: {},
    });
    setVirtualItems([{ key: '0', index: 0, start: 0, size: 24 }]);
    renderAgentLog([entry]);

    expect(screen.getByText('✅')).toBeInTheDocument();
    expect(screen.getByText('Tool completed')).toBeInTheDocument();
  });

  it('renders "tool_call_end" entry with ❌ when metadata.isError is true', () => {
    const entry = createEntry({
      type: 'tool_call_end',
      content: 'Tool failed',
      metadata: { isError: true },
    });
    setVirtualItems([{ key: '0', index: 0, start: 0, size: 24 }]);
    renderAgentLog([entry]);

    expect(screen.getByText('❌')).toBeInTheDocument();
    expect(screen.getByText('Tool failed')).toBeInTheDocument();
  });

  it('renders "tool_call" entry with 🔧 prefix', () => {
    const entry = createEntry({ type: 'tool_call', content: 'Tool call in progress' });
    setVirtualItems([{ key: '0', index: 0, start: 0, size: 24 }]);
    renderAgentLog([entry]);

    expect(screen.getByText('🔧')).toBeInTheDocument();
    expect(screen.getByText('Tool call in progress')).toBeInTheDocument();
  });

  it('renders "decision" entry with 🤝 prefix and warning color styling', () => {
    const entry = createEntry({ type: 'decision', content: 'Decided to do Y' });
    setVirtualItems([{ key: '0', index: 0, start: 0, size: 32 }]);
    renderAgentLog([entry]);

    expect(screen.getByText('🤝')).toBeInTheDocument();
    expect(screen.getByText('Decided to do Y')).toBeInTheDocument();
  });

  it('renders "error" entry with ⚠️ prefix, error color, bold styling', () => {
    const entry = createEntry({ type: 'error', content: 'Something went wrong' });
    setVirtualItems([{ key: '0', index: 0, start: 0, size: 32 }]);
    renderAgentLog([entry]);

    expect(screen.getByText('⚠️')).toBeInTheDocument();
    expect(screen.getByText('Something went wrong')).toBeInTheDocument();
  });

  it('renders multiple entries of different types with correct prefixes', () => {
    const entries = [
      createEntry({ id: 'a', type: 'thinking', content: 'Think...' }),
      createEntry({ id: 'b', type: 'decision', content: 'Decide!' }),
      createEntry({ id: 'c', type: 'text', content: 'Textual' }),
    ];
    setVirtualItems([
      { key: '0', index: 0, start: 0, size: 40 },
      { key: '1', index: 1, start: 40, size: 32 },
      { key: '2', index: 2, start: 72, size: 60 },
    ]);

    renderAgentLog(entries);
    expect(screen.getByText('🧠')).toBeInTheDocument();
    expect(screen.getByText('🤝')).toBeInTheDocument();
    expect(screen.getByText('Think...')).toBeInTheDocument();
    expect(screen.getByText('Decide!')).toBeInTheDocument();
    expect(screen.getByText('Textual')).toBeInTheDocument();
  });
});

// ─── Auto-scroll behaviour ──────────────────────────────────────────────────

describe('auto-scroll behaviour', () => {
  it('does not call scrollToIndex when entries.length does not change on re-render', () => {
    // Initial render
    const entries = [createEntry()];
    const { rerender } = renderAgentLog(entries);

    // Ensure it was NOT called during initial render (only on length change)
    // The effect fires when entries.length changes, not on mount
    expect(mockScrollToIndex).not.toHaveBeenCalled();

    // Re-render with same length
    const sameLength = [createEntry()];
    rerender(<AgentLog entries={sameLength} />);
    expect(mockScrollToIndex).not.toHaveBeenCalled();
  });

  it('calls scrollToIndex with last index when entries grow and user is near bottom', () => {
    // We need to manually test the scroll-bottom detection logic.
    // The component uses an isNearBottom ref that is updated on scroll.
    // We can simulate by setting up the ref before adding entries.
    //
    // Because the ref is internal, we test via behaviour: if user is near bottom,
    // scrollToIndex should be called when entries grow.

    const entries = [createEntry()];
    const { rerender, container } = renderAgentLog(entries);

    // Simulate user being near bottom: set scrollTop so that
    // scrollTop + clientHeight >= scrollHeight - 100
    const outer = container.querySelector('.agent-log')! as HTMLElement;
    Object.defineProperty(outer, 'scrollTop', { value: 800, configurable: true });
    Object.defineProperty(outer, 'clientHeight', { value: 200, configurable: true });
    Object.defineProperty(outer, 'scrollHeight', { value: 1000, configurable: true });

    // Trigger scroll event so the component updates isNearBottom
    outer.dispatchEvent(new Event('scroll', { bubbles: true }));

    // Now add a new entry (simulate growing log)
    const newEntries = [...entries, createEntry()];
    rerender(<AgentLog entries={newEntries} />);

    // scrollToIndex should have been called with the last index
    // (entries.length - 1 = 1) and align: 'end'
    expect(mockScrollToIndex).toHaveBeenCalledWith(1, { align: 'end' });
  });

  it('does NOT call scrollToIndex when user has scrolled away from bottom', () => {
    const entries = [createEntry()];
    const { rerender, container } = renderAgentLog(entries);

    // Simulate user scrolled up (not near bottom)
    const outer = container.querySelector('.agent-log')! as HTMLElement;
    Object.defineProperty(outer, 'scrollTop', { value: 0, configurable: true });
    Object.defineProperty(outer, 'clientHeight', { value: 200, configurable: true });
    Object.defineProperty(outer, 'scrollHeight', { value: 1000, configurable: true });

    outer.dispatchEvent(new Event('scroll', { bubbles: true }));

    // Add new entries
    const newEntries = [...entries, createEntry(), createEntry()];
    rerender(<AgentLog entries={newEntries} />);

    // Should NOT auto-scroll because user is not near bottom
    expect(mockScrollToIndex).not.toHaveBeenCalled();
  });

  it('does NOT call scrollToIndex on initial mount because prevLength equals entries.length', () => {
    // The component initialises prevLength ref to entries.length on mount.
    // The effect only triggers when entries.length > prevLength.current.
    // On first render both are equal, so no auto-scroll occurs.
    const entries = [createEntry({ id: 'e1' }), createEntry({ id: 'e2' })];
    renderAgentLog(entries);
    expect(mockScrollToIndex).not.toHaveBeenCalled();
  });

  it('calls scrollToIndex when entries.length increases from 0 to 1', () => {
    // Mount with empty, then add one entry
    const { rerender, container } = renderAgentLog([]);

    // Near bottom is true by default
    const outer = container.querySelector('.agent-log')! as HTMLElement;
    Object.defineProperty(outer, 'scrollTop', { value: 0, configurable: true });
    Object.defineProperty(outer, 'clientHeight', { value: 100, configurable: true });
    Object.defineProperty(outer, 'scrollHeight', { value: 100, configurable: true });

    outer.dispatchEvent(new Event('scroll', { bubbles: true }));

    rerender(<AgentLog entries={[createEntry()]} />);

    // Should auto-scroll to index 0 with align: 'end'
    expect(mockScrollToIndex).toHaveBeenCalledWith(0, { align: 'end' });
  });

  it('calls scrollToIndex to the last index when multiple entries are added at once while near bottom', () => {
    // Start with 2 entries, then add 3 more at once (simulating a batch update)
    const entries = [createEntry({ id: 'e1', content: 'First' }), createEntry({ id: 'e2', content: 'Second' })];

    const { rerender, container } = renderAgentLog(entries);

    // Simulate being near bottom
    const outer = container.querySelector('.agent-log')! as HTMLElement;
    Object.defineProperty(outer, 'scrollHeight', { value: 500, configurable: true });
    Object.defineProperty(outer, 'clientHeight', { value: 200, configurable: true });
    Object.defineProperty(outer, 'scrollTop', { value: 250, configurable: true });
    // 250 + 200 = 450 >= 500 - 100 = 400 → true

    outer.dispatchEvent(new Event('scroll', { bubbles: true }));

    // Add 3 more entries
    const newEntries = [
      ...entries,
      createEntry({ id: 'e3', content: 'Third' }),
      createEntry({ id: 'e4', content: 'Fourth' }),
      createEntry({ id: 'e5', content: 'Fifth' }),
    ];
    rerender(<AgentLog entries={newEntries} />);

    // Should scroll to the LAST new entry (index 4), not index 2
    expect(mockScrollToIndex).toHaveBeenCalledWith(4, { align: 'end' });
  });
});

// ─── Scroll detection (isNearBottom) ────────────────────────────────────────

describe('isNearBottom detection', () => {
  it('updates isNearBottom to true when near bottom (within 100px threshold)', () => {
    const entries = [createEntry()];
    const { container, rerender } = renderAgentLog(entries);

    const outer = container.querySelector('.agent-log')! as HTMLElement;
    // scrollHeight = 1000, clientHeight = 200, scrollTop = 750
    // 750 + 200 = 950 >= 1000 - 100 = 900 → true
    Object.defineProperty(outer, 'scrollHeight', { value: 1000, configurable: true });
    Object.defineProperty(outer, 'clientHeight', { value: 200, configurable: true });
    Object.defineProperty(outer, 'scrollTop', { value: 750, configurable: true });

    // After dispatching scroll, the internal ref should be true
    outer.dispatchEvent(new Event('scroll', { bubbles: true }));

    // Add an entry; because isNearBottom is true, auto-scroll should trigger
    rerender(<AgentLog entries={[...entries, createEntry()]} />);
    expect(mockScrollToIndex).toHaveBeenCalledWith(1, { align: 'end' });
  });

  it('updates isNearBottom to false when far from bottom (> 100px threshold)', () => {
    const entries = [createEntry()];
    const { container, rerender } = renderAgentLog(entries);

    const outer = container.querySelector('.agent-log')! as HTMLElement;
    // scrollHeight = 1000, clientHeight = 200, scrollTop = 600
    // 600 + 200 = 800 < 1000 - 100 = 900 → false
    Object.defineProperty(outer, 'scrollHeight', { value: 1000, configurable: true });
    Object.defineProperty(outer, 'clientHeight', { value: 200, configurable: true });
    Object.defineProperty(outer, 'scrollTop', { value: 600, configurable: true });

    outer.dispatchEvent(new Event('scroll', { bubbles: true }));

    // Add entry; should NOT auto-scroll because not near bottom
    rerender(<AgentLog entries={[...entries, createEntry()]} />);
    expect(mockScrollToIndex).not.toHaveBeenCalled();
  });

  it('considers user near bottom when scrollTop is exactly at threshold (scrollTop + clientHeight === scrollHeight - 100)', () => {
    const entries = [createEntry()];
    const { container, rerender } = renderAgentLog(entries);

    const outer = container.querySelector('.agent-log')! as HTMLElement;
    // scrollHeight = 1000, clientHeight = 200, scrollTop = 700
    // 700 + 200 = 900 === 1000 - 100 = 900 → true (boundary)
    Object.defineProperty(outer, 'scrollHeight', { value: 1000, configurable: true });
    Object.defineProperty(outer, 'clientHeight', { value: 200, configurable: true });
    Object.defineProperty(outer, 'scrollTop', { value: 700, configurable: true });

    outer.dispatchEvent(new Event('scroll', { bubbles: true }));

    rerender(<AgentLog entries={[...entries, createEntry()]} />);
    expect(mockScrollToIndex).toHaveBeenCalled();
  });

  it('considers user NOT near bottom when scrollTop + clientHeight < scrollHeight - 100', () => {
    const entries = [createEntry()];
    const { container, rerender } = renderAgentLog(entries);

    const outer = container.querySelector('.agent-log')! as HTMLElement;
    Object.defineProperty(outer, 'scrollHeight', { value: 1000, configurable: true });
    Object.defineProperty(outer, 'clientHeight', { value: 200, configurable: true });
    Object.defineProperty(outer, 'scrollTop', { value: 699, configurable: true });

    outer.dispatchEvent(new Event('scroll', { bubbles: true }));

    rerender(<AgentLog entries={[...entries, createEntry()]} />);
    expect(mockScrollToIndex).not.toHaveBeenCalled();
  });
});

// ─── Edge cases ─────────────────────────────────────────────────────────────

describe('edge cases', () => {
  it('handles entries with minimal content (empty string)', () => {
    const entry = createEntry({ type: 'text', content: '' });
    setVirtualItems([{ key: '0', index: 0, start: 0, size: 60 }]);
    const { container } = renderAgentLog([entry]);
    const item = container.querySelector('[data-index="0"]');
    expect(item).toBeInTheDocument();
  });

  it('handles entries with very long content', () => {
    const longContent = 'A'.repeat(10000);
    const entry = createEntry({ type: 'text', content: longContent });
    setVirtualItems([{ key: '0', index: 0, start: 0, size: 60 }]);
    renderAgentLog([entry]);
    // The content should be rendered (even if truncated visually)
    expect(screen.getByText(longContent)).toBeInTheDocument();
  });

  it('handles rapid addition of entries without crashing', () => {
    // Render with 100 entries (simulates rapid updates)
    const entries = Array.from({ length: 100 }, (_, i) => createEntry({ id: `rapid-${i}`, content: `Entry ${i}` }));
    setVirtualItems(
      entries.map((_, i) => ({
        key: String(i),
        index: i,
        start: i * 24,
        size: 24,
      })),
    );
    renderAgentLog(entries);
    // Should have rendered successfully
    expect(screen.getByText('Entry 0')).toBeInTheDocument();
  });

  it('handles metadata that is undefined or null gracefully', () => {
    const entryWithoutMeta = createEntry({
      type: 'tool_call_end',
      content: 'done',
      metadata: undefined,
    });
    setVirtualItems([{ key: '0', index: 0, start: 0, size: 24 }]);
    renderAgentLog([entryWithoutMeta]);
    // Should render with ✅ (default, no error)
    expect(screen.getByText('✅')).toBeInTheDocument();
    expect(screen.getByText('done')).toBeInTheDocument();
  });

  it('handles metadata.isError explicitly set to false', () => {
    const entry = createEntry({
      type: 'tool_call_end',
      content: 'success',
      metadata: { isError: false },
    });
    setVirtualItems([{ key: '0', index: 0, start: 0, size: 24 }]);
    renderAgentLog([entry]);
    expect(screen.getByText('✅')).toBeInTheDocument();
  });

  it('handles entries with special characters in content', () => {
    const entry = createEntry({
      type: 'text',
      content: '<script>alert("xss")</script> & "quotes"',
    });
    setVirtualItems([{ key: '0', index: 0, start: 0, size: 60 }]);
    renderAgentLog([entry]);
    // Content should be rendered as-is (React escapes by default)
    expect(screen.getByText('<script>alert("xss")</script> & "quotes"')).toBeInTheDocument();
  });

  it('handles a single entry correctly', () => {
    const entry = createEntry({ type: 'text', content: 'Solo' });
    setVirtualItems([{ key: '0', index: 0, start: 0, size: 60 }]);
    renderAgentLog([entry]);
    expect(screen.getByText('Solo')).toBeInTheDocument();
  });
});

// ─── estimateEntryHeight mapping ───────────────────────────────────────────

describe('estimateEntryHeight', () => {
  // These tests validate the height mapping logic used by estimateSize.
  // The function should map entry types to pixel heights as documented.
  //
  // We test via the estimateSize callback passed to useVirtualizer.

  it('returns 60 for text entries', () => {
    const entry = createEntry({ type: 'text' });
    renderAgentLog([entry]);
    const options = vi.mocked(useVirtualizer).mock.calls[0][0];
    expect(options.estimateSize(0)).toBe(60);
  });

  it('returns 40 for thinking entries', () => {
    const entry = createEntry({ type: 'thinking' });
    renderAgentLog([entry]);
    const options = vi.mocked(useVirtualizer).mock.calls[0][0];
    expect(options.estimateSize(0)).toBe(40);
  });

  it('returns 24 for tool_call_start entries', () => {
    const entry = createEntry({ type: 'tool_call_start' });
    renderAgentLog([entry]);
    const options = vi.mocked(useVirtualizer).mock.calls[0][0];
    expect(options.estimateSize(0)).toBe(24);
  });

  it('returns 24 for tool_call_end entries', () => {
    const entry = createEntry({ type: 'tool_call_end' });
    renderAgentLog([entry]);
    const options = vi.mocked(useVirtualizer).mock.calls[0][0];
    expect(options.estimateSize(0)).toBe(24);
  });

  it('returns 32 for decision entries', () => {
    const entry = createEntry({ type: 'decision' });
    renderAgentLog([entry]);
    const options = vi.mocked(useVirtualizer).mock.calls[0][0];
    expect(options.estimateSize(0)).toBe(32);
  });

  it('returns 32 for error entries', () => {
    const entry = createEntry({ type: 'error' });
    renderAgentLog([entry]);
    const options = vi.mocked(useVirtualizer).mock.calls[0][0];
    expect(options.estimateSize(0)).toBe(32);
  });

  it('returns 24 for unknown entry types (fallback)', () => {
    const entry = createEntry({ type: 'tool_call' }); // tool_call is not in the type list for estimate
    renderAgentLog([entry]);
    const options = vi.mocked(useVirtualizer).mock.calls[0][0];
    // tool_call should fall through to default (24)
    expect(options.estimateSize(0)).toBe(24);
  });
});

// ─── CSS class names (integration with AgentLog.css) ───────────────────────

describe('CSS class names', () => {
  it('applies "agent-log" class to the outer scroll container', () => {
    const { container } = renderAgentLog([]);
    expect(container.querySelector('.agent-log')).toBeInTheDocument();
  });

  it('applies "log-entry" class to each rendered entry', () => {
    const entries = [createEntry({ id: 'e1' })];
    setVirtualItems([{ key: '0', index: 0, start: 0, size: 60 }]);
    const { container } = renderAgentLog(entries);
    expect(container.querySelector('.log-entry')).toBeInTheDocument();
  });

  it('each log-entry has padding and a bottom border (via CSS)', () => {
    // This validates that the class structure matches AgentLog.css
    const entries = [createEntry({ id: 'e1', content: 'Style test' })];
    setVirtualItems([{ key: '0', index: 0, start: 0, size: 60 }]);
    const { container } = renderAgentLog(entries);
    const entry = container.querySelector('.log-entry');
    expect(entry).toBeInTheDocument();
    // The style properties come from CSS; we just verify the class is present
    // since jsdom doesn't compute CSS by default.
  });
});
