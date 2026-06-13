/**
 * Tests for EventLog – auto-scroll behavior.
 *
 * Verifies:
 * - Auto-scrolls to bottom when new entries arrive and user is near bottom
 * - Does NOT auto-scroll when the user has scrolled up
 * - Re-enables auto-scroll when the user scrolls back to the bottom
 * - Multiple new entries maintain auto-scroll position when at bottom
 */

import '@testing-library/jest-dom/vitest';

import { fireEvent, render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EventLog } from './EventLog';

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

describe('EventLog – auto-scroll behavior', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('auto-scrolls to bottom when new entries arrive and user is at bottom', () => {
    // Start with a few entries so the container exists
    const entries = ['a', 'b', 'c'];
    const { container, rerender } = render(<EventLog entries={entries} />);

    const scrollDiv = container.querySelector('.event-log') as HTMLDivElement;
    expect(scrollDiv).toBeInTheDocument();

    // Mock geometry BEFORE triggering the effect with new entries
    mockScrollGeometry(scrollDiv, 1000, 200);

    // Add a new entry – the effect re-runs because [entries] changed.
    // With the fix: autoScroll starts as true → scrolls to bottom.
    rerender(<EventLog entries={[...entries, 'd']} />);

    expect(scrollDiv.scrollTop).toBe(1000);
  });

  it('does NOT auto-scroll when user has scrolled away from the bottom', () => {
    const entries = ['a', 'b', 'c'];
    const { container, rerender } = render(<EventLog entries={entries} />);

    const scrollDiv = container.querySelector('.event-log') as HTMLDivElement;
    mockScrollGeometry(scrollDiv, 1000, 200);

    // Trigger initial auto-scroll with new entries
    rerender(<EventLog entries={[...entries, 'd']} />);
    expect(scrollDiv.scrollTop).toBe(1000);

    // Simulate user scrolling up – far from bottom
    // isNearBottom = scrollHeight - scrollTop - clientHeight < 30
    // 1000 - 100 - 200 = 700 >= 30 → not near bottom → autoScroll = false
    scrollTo(scrollDiv, 100);

    // Add another entry while scrolled up
    rerender(<EventLog entries={['a', 'b', 'c', 'd', 'e']} />);

    // With the fix: autoScroll is false, so scrollTop should NOT change.
    // With current code: scrollTop would be set to scrollHeight (1000).
    expect(scrollDiv.scrollTop).toBe(100);
  });

  it('re-enables auto-scroll when user scrolls back to the bottom', () => {
    const entries = ['a', 'b'];
    const { container, rerender } = render(<EventLog entries={entries} />);

    const scrollDiv = container.querySelector('.event-log') as HTMLDivElement;
    mockScrollGeometry(scrollDiv, 1000, 200);

    // Trigger initial auto-scroll
    rerender(<EventLog entries={[...entries, 'c']} />);
    expect(scrollDiv.scrollTop).toBe(1000);

    // User scrolls up (disables auto-scroll)
    scrollTo(scrollDiv, 100);
    expect(scrollDiv.scrollTop).toBe(100);

    // Add entries while scrolled up – should NOT scroll
    rerender(<EventLog entries={['a', 'b', 'c', 'd']} />);
    expect(scrollDiv.scrollTop).toBe(100);

    // Scroll back to bottom (within 30px threshold)
    // isNearBottom = 1000 - 970 - 200 = -170 < 30 → true → autoScroll = true
    scrollTo(scrollDiv, 970);

    // Add another entry – should auto-scroll now
    rerender(<EventLog entries={['a', 'b', 'c', 'd', 'e']} />);
    expect(scrollDiv.scrollTop).toBe(1000);
  });

  it('maintains auto-scroll when new entries arrive and user is already at bottom', () => {
    const entries = ['a', 'b'];
    const { container, rerender } = render(<EventLog entries={entries} />);

    const scrollDiv = container.querySelector('.event-log') as HTMLDivElement;
    mockScrollGeometry(scrollDiv, 1000, 200);

    // Trigger initial auto-scroll
    rerender(<EventLog entries={[...entries, 'c']} />);
    expect(scrollDiv.scrollTop).toBe(1000);

    // User is at bottom; multiple new entries arrive
    rerender(<EventLog entries={['a', 'b', 'c', 'd', 'e', 'f']} />);

    // Should still be at bottom (auto-scrolled each time)
    expect(scrollDiv.scrollTop).toBe(1000);
  });

  it('does not auto-scroll when user is at the threshold boundary (30px away)', () => {
    const entries = ['a', 'b'];
    const { container, rerender } = render(<EventLog entries={entries} />);

    const scrollDiv = container.querySelector('.event-log') as HTMLDivElement;
    mockScrollGeometry(scrollDiv, 1000, 200);

    // Trigger initial auto-scroll
    rerender(<EventLog entries={[...entries, 'c']} />);
    expect(scrollDiv.scrollTop).toBe(1000);

    // Scroll to exactly 770 → isNearBottom = 1000 - 770 - 200 = 30 → not < 30 → false
    scrollTo(scrollDiv, 770);

    // Add new entries
    rerender(<EventLog entries={['a', 'b', 'c', 'd']} />);

    // Should NOT auto-scroll because user is exactly at the threshold boundary
    expect(scrollDiv.scrollTop).toBe(770);
  });

  it('auto-scrolls when user is just within the threshold (29px away)', () => {
    const entries = ['a', 'b'];
    const { container, rerender } = render(<EventLog entries={entries} />);

    const scrollDiv = container.querySelector('.event-log') as HTMLDivElement;
    mockScrollGeometry(scrollDiv, 1000, 200);

    // Trigger initial auto-scroll
    rerender(<EventLog entries={[...entries, 'c']} />);
    expect(scrollDiv.scrollTop).toBe(1000);

    // Scroll to 771 → isNearBottom = 1000 - 771 - 200 = 29 < 30 → true
    scrollTo(scrollDiv, 771);

    // Add new entries
    rerender(<EventLog entries={['a', 'b', 'c', 'd']} />);

    // Should auto-scroll because user is within the 30px threshold
    expect(scrollDiv.scrollTop).toBe(1000);
  });
});
