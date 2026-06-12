import { describe, expect, it } from 'bun:test';
import { AgentLogWidget } from '../../../src/tui/components/agent-log-widget.js';

const WIDTH = 40;

// Arrow key escape sequences
const LEFT_ARROW = '\x1b[D';
const RIGHT_ARROW = '\x1b[C';

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
    expect(lines[0]).toContain('coder');
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
    // Access private maxEntries via a workaround: add 201 entries
    const widget = new AgentLogWidget(5);
    widget.selectAgent('agent-1', 'coder');
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

  it('wraps long content to width', () => {
    const widget = new AgentLogWidget(5);
    widget.selectAgent('agent-1', 'coder');
    widget.addEntry({
      type: 'text',
      content: 'This is a very long string that should wrap',
    });

    // width=20, prefix '  💬 ' has visibleWidth=5, remainingWidth=15
    // wrapTextWithAnsi splits at word boundaries: ['This is a very', 'long string', 'that should', 'wrap']
    const lines = widget.render(20);
    expect(lines.length).toBe(5);
    // Content should wrap across multiple lines, not be truncated with '…'
    const allContent = lines.join('');
    expect(allContent).not.toContain('…');
    // The wrapped content should appear across multiple entry lines
    const entryLines = lines.slice(1).filter((l) => l.trim().length > 0);
    expect(entryLines.length).toBeGreaterThan(1);
    // Verify specific wrapped segments are present
    expect(allContent).toContain('This is a very');
    expect(allContent).toContain('long string');
    expect(allContent).toContain('that should');
    expect(allContent).toContain('wrap');
  });

  it('wraps a very long single word', () => {
    const widget = new AgentLogWidget(5);
    widget.selectAgent('agent-1', 'coder');
    widget.addEntry({
      type: 'text',
      content: 'supercalifragilisticexpialidocious',
    });

    // width=20, prefix visibleWidth=5, remainingWidth=15
    // wrapTextWithAnsi splits mid-word: ['supercalifragil', 'isticexpialidoc', 'ious']
    const lines = widget.render(20);
    expect(lines.length).toBe(5);
    // The word should be split across multiple lines (mid-word wrapping)
    const allContent = lines.join('');
    expect(allContent).toContain('supercalifragil');
    expect(allContent).toContain('isticexpialidoc');
    expect(allContent).toContain('ious');
    // Only the first line should have the icon
    expect(lines[1]).toContain('💬');
    // Continuation lines should have spaces instead of icon
    expect(lines[2]).not.toContain('💬');
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
    // Only the latest entries should show (header + 1 most recent, since maxLines=3 and header takes 1)
    // visibleCount = 2, startIdx = max(0, 4-2) = 2, so entries[2]='c' and entries[3]='d'
    expect(lines[1]).toContain('c');
    expect(lines[2]).toContain('d');
  });

  it('uses default maxLines of 20', () => {
    const widget = new AgentLogWidget();
    widget.selectAgent('a', 'p');
    const lines = widget.render(WIDTH);
    expect(lines.length).toBe(20);
  });

  // ─── Per-agent state tests ──────────────────────────────────────────

  it('preserves entries when switching agents', () => {
    const widget = new AgentLogWidget(5);
    widget.selectAgent('agent-1', 'coder');
    widget.addEntry({ type: 'text', content: 'hello from agent 1' });

    widget.selectAgent('agent-2', 'scout');
    widget.addEntry({ type: 'text', content: 'hello from agent 2' });

    // Switch back to agent 1
    widget.selectAgent('agent-1', 'coder');
    const lines1 = widget.render(WIDTH);
    // Header + entries for agent 1
    expect(lines1[1]).toContain('hello from agent 1');

    // Switch to agent 2
    widget.selectAgent('agent-2', 'scout');
    const lines2 = widget.render(WIDTH);
    expect(lines2[1]).toContain('hello from agent 2');
  });

  it('re-selecting an agent preserves previous entries', () => {
    const widget = new AgentLogWidget(5);
    widget.selectAgent('agent-1', 'coder');
    widget.addEntry({ type: 'text', content: 'first entry' });
    widget.addEntry({ type: 'text', content: 'second entry' });

    // Re-select same agent
    widget.selectAgent('agent-1', 'coder');
    const lines = widget.render(WIDTH);
    // Both entries should still be there
    expect(lines[1]).toContain('first entry');
    expect(lines[2]).toContain('second entry');
  });

  it('header shows stats (toolCallCount, tokens)', () => {
    const widget = new AgentLogWidget(5);
    widget.selectAgent('agent-1', 'coder');
    widget.updateStats('agent-1', { toolCallCount: 1 });
    widget.updateStats('agent-1', { toolCallCount: 1 });
    widget.updateStats('agent-1', { inputTokens: 100 });
    widget.updateStats('agent-1', { outputTokens: 50 });

    const lines = widget.render(80);
    expect(lines[0]).toContain('2 tool calls');
    expect(lines[0]).toContain('↑100');
    expect(lines[0]).toContain('↓50');
  });

  it('header shows taskTitle when set', () => {
    const widget = new AgentLogWidget(5);
    widget.selectAgent('agent-1', 'coder');
    widget.updateStats('agent-1', { taskTitle: 'Implement feature X' });

    const lines = widget.render(WIDTH);
    expect(lines[0]).toContain('Implement feature X');
    expect(lines[0]).toContain('profile: coder');
  });

  it('getAgentIds returns all stored agent IDs', () => {
    const widget = new AgentLogWidget(5);
    expect(widget.getAgentIds()).toEqual([]);

    widget.selectAgent('agent-1', 'coder');
    widget.selectAgent('agent-2', 'scout');
    widget.selectAgent('agent-3', 'planner');

    expect(widget.getAgentIds()).toEqual(['agent-1', 'agent-2', 'agent-3']);
  });

  it('getCurrentAgentId returns the currently selected agent', () => {
    const widget = new AgentLogWidget(5);
    expect(widget.getCurrentAgentId()).toBeNull();
    expect(widget.getCurrentAgentId()).toBeNull();

    widget.selectAgent('agent-1', 'coder');
    expect(widget.getCurrentAgentId()).toBe('agent-1');
    expect(widget.getCurrentAgentId()).toBe('agent-1');

    widget.selectAgent('agent-2', 'scout');
    expect(widget.getCurrentAgentId()).toBe('agent-2');
  });

  // ─── updateStats tests ──────────────────────────────────────────────

  it('updateStats accumulates numeric fields', () => {
    const widget = new AgentLogWidget(5);
    widget.selectAgent('agent-1', 'coder');

    widget.updateStats('agent-1', { toolCallCount: 1 });
    widget.updateStats('agent-1', { toolCallCount: 2 });
    widget.updateStats('agent-1', { inputTokens: 100 });
    widget.updateStats('agent-1', { inputTokens: 200 });
    widget.updateStats('agent-1', { outputTokens: 50 });
    widget.updateStats('agent-1', { outputTokens: 25 });

    const lines = widget.render(80);
    expect(lines[0]).toContain('3 tool calls');
    expect(lines[0]).toContain('↑300');
    expect(lines[0]).toContain('↓75');
  });

  it('updateStats sets string fields', () => {
    const widget = new AgentLogWidget(5);
    widget.selectAgent('agent-1', 'coder');
    widget.updateStats('agent-1', { taskTitle: 'First title' });
    widget.updateStats('agent-1', { taskTitle: 'Updated title' });
    widget.updateStats('agent-1', { profile: 'scout' });

    const lines = widget.render(WIDTH);
    expect(lines[0]).toContain('Updated title');
    expect(lines[0]).toContain('profile: scout');
  });

  it('updateStats creates agent data if not found', () => {
    const widget = new AgentLogWidget(5);
    // No selectAgent call — updateStats should still work
    widget.updateStats('agent-x', { toolCallCount: 5, taskTitle: 'Test' });

    expect(widget.getAgentIds()).toContain('agent-x');
    // But it's not selected, so it shouldn't affect render
    const lines = widget.render(WIDTH);
    expect(lines[0]).toContain('No agent selected');
  });

  // ─── Footer / multi-agent navigation ───────────────────────────────

  it('shows footer when multiple agents exist', () => {
    const widget = new AgentLogWidget(5);
    widget.selectAgent('agent-1', 'coder');
    widget.selectAgent('agent-2', 'scout');
    // agent-2 is current
    const lines = widget.render(80);
    // Last line should have footer
    expect(lines[lines.length - 1]).toContain('← → switch agent');
    expect(lines[lines.length - 1]).toContain('2/2');
  });

  it('does not show footer with single agent', () => {
    const widget = new AgentLogWidget(5);
    widget.selectAgent('agent-1', 'coder');
    const lines = widget.render(WIDTH);
    // No line should contain the footer text
    for (const line of lines) {
      expect(line).not.toContain('← → switch agent');
    }
  });

  it('footer shows correct index for first agent', () => {
    const widget = new AgentLogWidget(5);
    widget.selectAgent('agent-1', 'coder');
    widget.selectAgent('agent-2', 'scout');
    // Navigate back to first
    widget.selectAgent('agent-1', 'coder');
    const lines = widget.render(80);
    expect(lines[lines.length - 1]).toContain('1/2');
  });

  // ─── Left/right navigation ─────────────────────────────────────────

  it('left arrow cycles to previous agent (wrapping)', () => {
    const widget = new AgentLogWidget(5);
    widget.selectAgent('agent-1', 'coder');
    widget.selectAgent('agent-2', 'scout');
    widget.selectAgent('agent-3', 'planner');
    // Current is agent-3

    widget.handleInput(LEFT_ARROW);
    expect(widget.getCurrentAgentId()).toBe('agent-2');

    widget.handleInput(LEFT_ARROW);
    expect(widget.getCurrentAgentId()).toBe('agent-1');

    // Wrap around
    widget.handleInput(LEFT_ARROW);
    expect(widget.getCurrentAgentId()).toBe('agent-3');
  });

  it('right arrow cycles to next agent (wrapping)', () => {
    const widget = new AgentLogWidget(5);
    widget.selectAgent('agent-1', 'coder');
    widget.selectAgent('agent-2', 'scout');
    widget.selectAgent('agent-3', 'planner');
    // Current is agent-3

    // Wrap around to first
    widget.handleInput(RIGHT_ARROW);
    expect(widget.getCurrentAgentId()).toBe('agent-1');

    widget.handleInput(RIGHT_ARROW);
    expect(widget.getCurrentAgentId()).toBe('agent-2');

    widget.handleInput(RIGHT_ARROW);
    expect(widget.getCurrentAgentId()).toBe('agent-3');
  });

  it('handleInput does nothing with single agent', () => {
    const widget = new AgentLogWidget(5);
    widget.selectAgent('agent-1', 'coder');
    widget.handleInput(LEFT_ARROW);
    expect(widget.getCurrentAgentId()).toBe('agent-1');
    widget.handleInput(RIGHT_ARROW);
    expect(widget.getCurrentAgentId()).toBe('agent-1');
  });

  it('handleInput does nothing with no agents', () => {
    const widget = new AgentLogWidget(5);
    widget.handleInput(LEFT_ARROW);
    expect(widget.getCurrentAgentId()).toBeNull();
    widget.handleInput(RIGHT_ARROW);
    expect(widget.getCurrentAgentId()).toBeNull();
  });

  it('navigation preserves per-agent entries', () => {
    const widget = new AgentLogWidget(5);
    widget.selectAgent('agent-1', 'coder');
    widget.addEntry({ type: 'text', content: 'agent-1-msg' });

    widget.selectAgent('agent-2', 'scout');
    widget.addEntry({ type: 'text', content: 'agent-2-msg' });

    // Navigate back to agent-1
    widget.handleInput(LEFT_ARROW);
    expect(widget.getCurrentAgentId()).toBe('agent-1');
    const lines = widget.render(WIDTH);
    expect(lines[1]).toContain('agent-1-msg');

    // Navigate to agent-2
    widget.handleInput(RIGHT_ARROW);
    expect(widget.getCurrentAgentId()).toBe('agent-2');
    const lines2 = widget.render(WIDTH);
    expect(lines2[1]).toContain('agent-2-msg');
  });

  // ─── clearAgent ─────────────────────────────────────────────────────

  it('clearAgent resets to no agent selected', () => {
    const widget = new AgentLogWidget(5);
    widget.selectAgent('agent-1', 'coder');
    widget.addEntry({ type: 'text', content: 'hello' });

    widget.clearAgent();
    expect(widget.getCurrentAgentId()).toBeNull();
    const lines = widget.render(WIDTH);
    expect(lines[0]).toContain('No agent selected');
  });

  it('clearAgent preserves agent data for later re-selection', () => {
    const widget = new AgentLogWidget(5);
    widget.selectAgent('agent-1', 'coder');
    widget.addEntry({ type: 'text', content: 'hello' });

    widget.clearAgent();
    widget.selectAgent('agent-1', 'coder');
    const lines = widget.render(WIDTH);
    expect(lines[1]).toContain('hello');
  });

  // ─── Multi-line entry rendering ──────────────────────────────────────

  it('splits multi-line entries into separate rendered lines', () => {
    const widget = new AgentLogWidget(10);
    widget.selectAgent('agent-1', 'coder');
    widget.addEntry({ type: 'thinking', content: 'line1\nline2\nline3' });

    const lines = widget.render(WIDTH);
    expect(lines.length).toBe(10);
    // lines[0] = header
    expect(lines[1]).toContain('🧠');
    expect(lines[1]).toContain('line1');
    // Continuation lines should NOT have the icon
    expect(lines[2]).toContain('line2');
    expect(lines[2]).not.toContain('🧠');
    expect(lines[3]).toContain('line3');
    expect(lines[3]).not.toContain('🧠');
  });

  it('counts actual lines not entries for slot budget', () => {
    // A 5-line widget: 1 header + 4 entry slots
    // One multi-line entry with 6 sub-lines should only show the last 4
    const widget = new AgentLogWidget(5);
    widget.selectAgent('agent-1', 'coder');
    widget.addEntry({ type: 'text', content: 'a\nb\nc\nd\ne\nf' });

    const lines = widget.render(WIDTH);
    expect(lines.length).toBe(5);
    // Only last 4 sub-lines fit: c, d, e, f
    expect(lines[1]).toContain('c');
    expect(lines[2]).toContain('d');
    expect(lines[3]).toContain('e');
    expect(lines[4]).toContain('f');
  });

  it('continuation lines have aligned prefix with no icon', () => {
    const widget = new AgentLogWidget(10);
    widget.selectAgent('agent-1', 'coder');
    widget.addEntry({ type: 'error', content: 'msg1\nmsg2' });

    const lines = widget.render(WIDTH);
    // First sub-line has the icon
    expect(lines[1]).toContain('⚠️');
    expect(lines[1]).toContain('msg1');
    // Second sub-line is a continuation — spaces instead of icon
    expect(lines[2]).toContain('msg2');
    expect(lines[2]).not.toContain('⚠️');
  });

  it('multi-line entry with footer still returns exactly maxLines', () => {
    const widget = new AgentLogWidget(5);
    widget.selectAgent('agent-1', 'coder');
    widget.selectAgent('agent-2', 'scout');
    // agent-2 is current; footer takes 1 line → header(1) + entry slots(3) + footer(1) = 5
    widget.addEntry({ type: 'text', content: 'a\nb\nc\nd\ne\nf' });

    const lines = widget.render(80);
    expect(lines.length).toBe(5);
    // Header + 3 entry sub-lines + footer
    // Last 3 sub-lines of 6: d, e, f
    expect(lines[1]).toContain('d');
    expect(lines[2]).toContain('e');
    expect(lines[3]).toContain('f');
    expect(lines[4]).toContain('← → switch agent');
  });

  it('multiple entries each with newlines render correctly', () => {
    const widget = new AgentLogWidget(10);
    widget.selectAgent('agent-1', 'coder');
    widget.addEntry({ type: 'text', content: 'first\nsecond' });
    widget.addEntry({ type: 'thinking', content: 'alpha\nbeta' });

    const lines = widget.render(WIDTH);
    expect(lines.length).toBe(10);
    // header + 4 sub-lines + 5 padding = 10
    expect(lines[1]).toContain('💬');
    expect(lines[1]).toContain('first');
    expect(lines[2]).toContain('second');
    expect(lines[3]).toContain('🧠');
    expect(lines[3]).toContain('alpha');
    expect(lines[4]).toContain('beta');
  });

  // ─── markAgentComplete / footer counts ─────────────────────────────

  it('footer shows active and completed counts', () => {
    const widget = new AgentLogWidget(5);
    widget.selectAgent('agent-1', 'coder');
    widget.selectAgent('agent-2', 'scout');
    widget.selectAgent('agent-3', 'planner');
    widget.markAgentComplete('agent-1');

    const lines = widget.render(80);
    const footer = lines[lines.length - 1];
    expect(footer).toContain('2 active, 1 done');
    expect(footer).toContain('← → switch agent');
  });

  it('footer format when no agents completed', () => {
    const widget = new AgentLogWidget(5);
    widget.selectAgent('agent-1', 'coder');
    widget.selectAgent('agent-2', 'scout');

    const lines = widget.render(80);
    const footer = lines[lines.length - 1];
    expect(footer).toContain('← → switch agent (2/2)');
    // Should NOT contain the active/done text
    expect(footer).not.toContain('active');
    expect(footer).not.toContain('done');
  });

  it('markAgentComplete tracks completed state', () => {
    const widget = new AgentLogWidget(5);
    widget.selectAgent('agent-1', 'coder');
    widget.selectAgent('agent-2', 'scout');

    // Before marking any complete
    let lines = widget.render(80);
    let footer = lines[lines.length - 1];
    expect(footer).not.toContain('active');

    widget.markAgentComplete('agent-1');

    // After marking one complete
    lines = widget.render(80);
    footer = lines[lines.length - 1];
    expect(footer).toContain('1 active, 1 done');

    widget.markAgentComplete('agent-2');

    // After marking both complete
    lines = widget.render(80);
    footer = lines[lines.length - 1];
    expect(footer).toContain('0 active, 2 done');
  });

  it('cache eviction respects MAX_CACHED_AGENTS of 100', () => {
    const widget = new AgentLogWidget(5);
    // Add 101 agents
    for (let i = 0; i < 101; i++) {
      widget.selectAgent(`agent-${i}`, 'coder');
    }
    // After 101, one should have been evicted, leaving 100
    expect(widget.getAgentIds().length).toBe(100);
    // The first non-current agent should have been evicted (agent-0)
    // Current agent is agent-100
    expect(widget.getAgentIds()).not.toContain('agent-0');
    expect(widget.getAgentIds()).toContain('agent-100');
  });
});
