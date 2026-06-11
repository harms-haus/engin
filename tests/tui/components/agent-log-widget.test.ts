import { describe, expect, it } from 'bun:test';
import { AgentLogWidget } from '../../../src/tui/components/agent-log-widget.js';

const WIDTH = 40;

describe('AgentLogWidget', () => {
  it("renders 'No agent selected' when empty", () => {
    const widget = new AgentLogWidget(5);
    const lines = widget.render(WIDTH);

    expect(lines.length).toBe(5);
    expect(lines[0]).toContain('No agent selected');
    // Remaining lines should be empty (just padding spaces)
    for (let i = 1; i < 5; i++) {
      expect(lines[i].trim()).toBe('');
    }
  });

  it('renders agent header with profile name', () => {
    const widget = new AgentLogWidget(5);
    widget.selectAgent('agent-1', 'coder');
    const lines = widget.render(WIDTH);

    expect(lines.length).toBe(5);
    expect(lines[0]).toContain('Agent: coder');
  });

  it('renders entries with correct type icons', () => {
    const widget = new AgentLogWidget(5);
    widget.selectAgent('agent-1', 'coder');
    widget.addEntry({ type: 'text', content: 'hello' });
    widget.addEntry({ type: 'thinking', content: 'pondering' });
    widget.addEntry({ type: 'error', content: 'oops' });

    const lines = widget.render(WIDTH);

    // lines[0] = header, lines[1-3] = entries, lines[4] = empty
    expect(lines[1]).toContain('💬');
    expect(lines[2]).toContain('🧠');
    expect(lines[3]).toContain('⚠️');
    expect(lines[4].trim()).toBe('');
  });

  it('ring buffer drops old entries when maxEntries exceeded', () => {
    const widget = new AgentLogWidget(5);
    widget.selectAgent('agent-1', 'coder');

    // Access private maxEntries via a workaround: add 201 entries
    for (let i = 0; i < 201; i++) {
      widget.addEntry({ type: 'text', content: `entry-${i}` });
    }

    // The widget should still function — latest entry should be visible
    // Use a large maxLines to see more entries
    // Create a new widget with more lines to check
    const bigWidget = new AgentLogWidget(200);
    bigWidget.selectAgent('agent-2', 'coder');
    for (let i = 0; i < 201; i++) {
      bigWidget.addEntry({ type: 'text', content: `entry-${i}` });
    }
    const lines = bigWidget.render(80);

    // entries[0] (entry-0) was shifted when count went from 200→201
    // With maxLines=200, visibleCount=199, startIdx = max(0, 200-199) = 1
    // So the first visible entry is entries[1] which is original entry-2
    expect(lines[1]).toContain('entry-2');
    // Last entry should be entry-200
    expect(lines[199]).toContain('entry-200');
    // Header + 199 visible entries = 200 lines total
    expect(lines.length).toBe(200);
  });

  it('ignores addEntry when no agent selected', () => {
    const widget = new AgentLogWidget(5);
    widget.addEntry({ type: 'text', content: 'should be ignored' });

    const lines = widget.render(WIDTH);
    expect(lines.length).toBe(5);
    // Header says no agent, no entries should appear
    expect(lines[0]).toContain('No agent selected');
    for (let i = 1; i < 5; i++) {
      expect(lines[i].trim()).toBe('');
    }
  });

  it('truncates content to width', () => {
    const widget = new AgentLogWidget(3);
    widget.selectAgent('agent-1', 'coder');
    widget.addEntry({
      type: 'text',
      content: 'This is a very long string that should be truncated',
    });

    const lines = widget.render(20);
    expect(lines.length).toBe(3);
    // Each line should have visible width of 20
    // The content line should not exceed the width
    // We check that the line contains the beginning of the content
    expect(lines[1]).toContain('This is a');
  });

  it('always returns exactly maxLines lines', () => {
    // Test with 0 entries
    const w1 = new AgentLogWidget(3);
    w1.selectAgent('a', 'p');
    expect(w1.render(WIDTH).length).toBe(3);

    // Test with 1 entry (less than maxLines - 1)
    const w2 = new AgentLogWidget(3);
    w2.selectAgent('a', 'p');
    w2.addEntry({ type: 'text', content: 'hi' });
    expect(w2.render(WIDTH).length).toBe(3);

    // Test with exactly maxLines - 1 entries
    const w3 = new AgentLogWidget(3);
    w3.selectAgent('a', 'p');
    w3.addEntry({ type: 'text', content: 'hi' });
    w3.addEntry({ type: 'text', content: 'there' });
    expect(w3.render(WIDTH).length).toBe(3);

    // Test with more entries than maxLines - 1
    const w4 = new AgentLogWidget(3);
    w4.selectAgent('a', 'p');
    w4.addEntry({ type: 'text', content: 'a' });
    w4.addEntry({ type: 'text', content: 'b' });
    w4.addEntry({ type: 'text', content: 'c' });
    w4.addEntry({ type: 'text', content: 'd' });
    const lines = w4.render(WIDTH);
    expect(lines.length).toBe(3);
    // Only the latest entries should show (header + 2 most recent)
    expect(lines[1]).toContain('c');
    expect(lines[2]).toContain('d');
  });
});
