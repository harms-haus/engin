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
    // Last line should have footer with new-style text
    expect(lines[lines.length - 1]).toContain('left/right switch agent');
    expect(lines[lines.length - 1]).toContain('2/2');
  });

  it('does not show footer with single agent', () => {
    const widget = new AgentLogWidget(5);
    widget.selectAgent('agent-1', 'coder');
    const lines = widget.render(WIDTH);
    // No line should contain footer text
    for (const line of lines) {
      expect(line).not.toContain('switch agent');
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
    expect(lines[4]).toContain('switch agent');
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

  it('markAgentComplete marks agent as complete', () => {
    const widget = new AgentLogWidget(5);
    widget.selectAgent('agent-1', 'coder');
    widget.selectAgent('agent-2', 'scout');

    // Before marking complete, agent is still in agent list
    expect(widget.getAgentIds()).toContain('agent-1');

    widget.markAgentComplete('agent-1');

    // Agent should still be in the list
    expect(widget.getAgentIds()).toContain('agent-1');
  });

  it('markAgentComplete preserves agent data', () => {
    const widget = new AgentLogWidget(5);
    widget.selectAgent('agent-1', 'coder');
    widget.addEntry({ type: 'text', content: 'test data' });
    widget.markAgentComplete('agent-1');

    // Agent data is preserved
    widget.selectAgent('agent-1', 'coder');
    const lines = widget.render(WIDTH);
    expect(lines[1]).toContain('test data');
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

  // ─── Phase data model ───────────────────────────────────────────────

  describe('phase data model', () => {
    it('setCurrentPhase sets current phase and returns it via getCurrentPhase', () => {
      const widget = new AgentLogWidget(5);
      expect(widget.getCurrentPhase()).toBeNull();
      widget.setCurrentPhase('planning');
      expect(widget.getCurrentPhase()).toBe('planning');
      widget.setCurrentPhase('execution');
      expect(widget.getCurrentPhase()).toBe('execution');
    });

    it('setCurrentPhase selects first agent in phase when agents exist', () => {
      const widget = new AgentLogWidget(5);
      // Add agents to phases via selectAgentInPhase
      widget.selectAgentInPhase('agent-1', 'planning', 'planner');
      widget.selectAgentInPhase('agent-2', 'planning', 'planner');
      widget.selectAgentInPhase('agent-3', 'execution', 'executor');

      // Switch to planning phase — should select first planning agent
      widget.setCurrentPhase('planning');
      expect(widget.getCurrentPhase()).toBe('planning');
      expect(widget.getCurrentAgentId()).toBe('agent-1');

      // Switch to execution phase — should select first execution agent
      widget.setCurrentPhase('execution');
      expect(widget.getCurrentPhase()).toBe('execution');
      expect(widget.getCurrentAgentId()).toBe('agent-3');
    });

    it('setCurrentPhase does not change currentAgentId when no agents in phase', () => {
      const widget = new AgentLogWidget(5);
      widget.selectAgent('agent-1', 'coder');
      expect(widget.getCurrentAgentId()).toBe('agent-1');

      widget.setCurrentPhase('planning');
      expect(widget.getCurrentPhase()).toBe('planning');
      // No agents in 'planning' phase, so currentAgentId unchanged
      expect(widget.getCurrentAgentId()).toBe('agent-1');
    });

    it('setCurrentPhase is no-op when same phase is set', () => {
      const widget = new AgentLogWidget(5);
      widget.setCurrentPhase('planning');
      // Track dirty state indirectly — just ensure no crash
      widget.setCurrentPhase('planning');
      expect(widget.getCurrentPhase()).toBe('planning');
    });

    it('setAvailablePhases stores and returns phases via getAvailablePhases', () => {
      const widget = new AgentLogWidget(5);
      expect(widget.getAvailablePhases()).toEqual([]);

      widget.setAvailablePhases(['planning', 'execution', 'review']);
      expect(widget.getAvailablePhases()).toEqual(['planning', 'execution', 'review']);

      // Returns a copy, not the internal reference
      const phases = widget.getAvailablePhases();
      phases.push('deploy');
      expect(widget.getAvailablePhases()).toEqual(['planning', 'execution', 'review']);
    });

    it('setAvailablePhases prunes started phases and agentsByPhase for removed phases', () => {
      const widget = new AgentLogWidget(5);
      widget.setAvailablePhases(['planning', 'execution', 'review']);
      widget.selectAgentInPhase('agent-1', 'planning', 'planner');
      widget.selectAgentInPhase('agent-2', 'execution', 'executor');

      expect(widget.getStartedPhases()).toEqual(['planning', 'execution']);
      expect(widget.getAgentsForPhase('planning')).toEqual(['agent-1']);
      expect(widget.getAgentsForPhase('execution')).toEqual(['agent-2']);

      // Remove 'execution' from available phases
      widget.setAvailablePhases(['planning', 'review']);

      expect(widget.getAvailablePhases()).toEqual(['planning', 'review']);
      expect(widget.getStartedPhases()).toEqual(['planning']);
      expect(widget.getAgentsForPhase('planning')).toEqual(['agent-1']);
      expect(widget.getAgentsForPhase('execution')).toEqual([]);
    });

    it('addStartedPhase tracks phases returned by getStartedPhases in insertion order', () => {
      const widget = new AgentLogWidget(5);
      expect(widget.getStartedPhases()).toEqual([]);

      widget.addStartedPhase('planning');
      expect(widget.getStartedPhases()).toEqual(['planning']);

      widget.addStartedPhase('execution');
      expect(widget.getStartedPhases()).toEqual(['planning', 'execution']);

      // Adding same phase again should not duplicate
      widget.addStartedPhase('planning');
      expect(widget.getStartedPhases()).toEqual(['planning', 'execution']);
    });

    it('getAgentsForPhase returns agents assigned to a specific phase', () => {
      const widget = new AgentLogWidget(5);

      expect(widget.getAgentsForPhase('planning')).toEqual([]);

      widget.selectAgentInPhase('agent-1', 'planning', 'planner');
      widget.selectAgentInPhase('agent-2', 'planning', 'planner');
      widget.selectAgentInPhase('agent-3', 'execution', 'executor');

      expect(widget.getAgentsForPhase('planning')).toEqual(['agent-1', 'agent-2']);
      expect(widget.getAgentsForPhase('execution')).toEqual(['agent-3']);

      // Returns a copy, not the internal reference
      const agents = widget.getAgentsForPhase('planning');
      agents.push('agent-99');
      expect(widget.getAgentsForPhase('planning')).toEqual(['agent-1', 'agent-2']);
    });

    it('selectAgentInPhase assigns phase to agent data and adds to agentsByPhase', () => {
      const widget = new AgentLogWidget(5);

      widget.selectAgentInPhase('agent-1', 'planning', 'planner');

      expect(widget.getCurrentAgentId()).toBe('agent-1');
      expect(widget.getAgentsForPhase('planning')).toEqual(['agent-1']);
      expect(widget.getStartedPhases()).toEqual(['planning']);

      // Agent data should have phase set
      // We can verify via getAgentsForPhase and the fact it's tracked
      expect(widget.getAgentsForPhase('planning')).toContain('agent-1');
    });

    it('selectAgentInPhase does not duplicate agent in phase', () => {
      const widget = new AgentLogWidget(5);

      widget.selectAgentInPhase('agent-1', 'planning', 'planner');
      widget.selectAgentInPhase('agent-1', 'planning', 'planner');

      expect(widget.getAgentsForPhase('planning')).toEqual(['agent-1']);
    });

    it('selectAgent with currentPhase set auto-assigns that phase to the agent', () => {
      const widget = new AgentLogWidget(5);

      widget.setCurrentPhase('planning');
      widget.selectAgent('agent-1', 'planner');

      // Agent should be auto-assigned to the current phase
      expect(widget.getAgentsForPhase('planning')).toEqual(['agent-1']);
      expect(widget.getStartedPhases()).toEqual(['planning']);

      // Selecting another agent should also auto-assign
      widget.selectAgent('agent-2', 'planner');
      expect(widget.getAgentsForPhase('planning')).toEqual(['agent-1', 'agent-2']);
    });

    it('selectAgent with currentPhase set only auto-assigns if agent has no phase yet', () => {
      const widget = new AgentLogWidget(5);

      // First assign agent to 'planning' phase
      widget.selectAgentInPhase('agent-1', 'planning', 'planner');

      // Now set current phase to 'execution'
      widget.setCurrentPhase('execution');

      // Re-select agent-1 — since it already has phase 'planning', it should NOT be overwritten
      widget.selectAgent('agent-1', 'planner');

      expect(widget.getAgentsForPhase('planning')).toEqual(['agent-1']);
      expect(widget.getAgentsForPhase('execution')).toEqual([]);
    });

    it('updateStats with phase field assigns phase to agent data', () => {
      const widget = new AgentLogWidget(5);

      widget.selectAgent('agent-1', 'planner');
      widget.updateStats('agent-1', { phase: 'planning' });

      expect(widget.getAgentsForPhase('planning')).toEqual(['agent-1']);
      expect(widget.getStartedPhases()).toEqual(['planning']);
    });

    it('updateStats with phase field adds to agentsByPhase and startedPhases', () => {
      const widget = new AgentLogWidget(5);

      widget.updateStats('agent-1', { phase: 'planning', profile: 'planner' });

      expect(widget.getAgentsForPhase('planning')).toEqual(['agent-1']);
      expect(widget.getStartedPhases()).toEqual(['planning']);
    });

    it('getStartedPhases returns phases in insertion order even when added out of order via addStartedPhase', () => {
      const widget = new AgentLogWidget(5);

      widget.addStartedPhase('review');
      widget.addStartedPhase('planning');
      widget.addStartedPhase('deploy');

      expect(widget.getStartedPhases()).toEqual(['review', 'planning', 'deploy']);

      // Now add 'execution' which was started after 'planning' but before 'deploy'
      widget.addStartedPhase('execution');
      expect(widget.getStartedPhases()).toEqual(['review', 'planning', 'deploy', 'execution']);
    });

    it('getStartedPhases returns phases in insertion order via selectAgentInPhase', () => {
      const widget = new AgentLogWidget(5);

      widget.selectAgentInPhase('agent-1', 'execution', 'executor');
      widget.selectAgentInPhase('agent-2', 'planning', 'planner');
      widget.selectAgentInPhase('agent-3', 'review', 'reviewer');

      expect(widget.getStartedPhases()).toEqual(['execution', 'planning', 'review']);
    });

    it('getStartedPhases returns a copy of internal list', () => {
      const widget = new AgentLogWidget(5);
      widget.addStartedPhase('planning');

      const phases = widget.getStartedPhases();
      phases.push('mutated');
      expect(widget.getStartedPhases()).toEqual(['planning']);
    });
  });

  // ─── Expand / collapse and scroll ───────────────────────────────────

  describe('expand/collapse and scroll', () => {
    it('toggleExpand flips expanded state', () => {
      const widget = new AgentLogWidget(5);
      expect(widget.isExpanded()).toBe(false);
      widget.toggleExpand();
      expect(widget.isExpanded()).toBe(true);
      widget.toggleExpand();
      expect(widget.isExpanded()).toBe(false);
    });

    it('getExpandedLineCount returns 40 when expanded, maxLines when collapsed', () => {
      const widget = new AgentLogWidget(5);
      expect(widget.getExpandedLineCount()).toBe(5);
      widget.toggleExpand();
      expect(widget.getExpandedLineCount()).toBe(40);
      widget.toggleExpand();
      expect(widget.getExpandedLineCount()).toBe(5);
    });

    it('render returns expandedLineCount lines when expanded', () => {
      const widget = new AgentLogWidget(5);
      widget.selectAgent('agent-1', 'coder');

      // Collapsed: 5 lines
      expect(widget.render(WIDTH).length).toBe(5);

      widget.toggleExpand();

      // Expanded: 40 lines (no agent selected would be 40 too, but we have an agent)
      const lines = widget.render(WIDTH);
      expect(lines.length).toBe(40);
      expect(lines[0]).toContain('coder');
    });

    it('scroll offset increases on up arrow when expanded', () => {
      const widget = new AgentLogWidget(10);
      widget.selectAgent('agent-1', 'coder');
      // Add enough entries to allow scrolling (need > entrySlots lines)
      // entrySlots = expanded(40) - 1 = 39 (single agent, no footer)
      for (let i = 0; i < 45; i++) {
        widget.addEntry({ type: 'text', content: `entry-${i}` });
      }

      widget.toggleExpand();

      // Render to compute _lastTotalEntryLines
      widget.render(80);

      // Up arrow should increase scroll offset
      widget.handleInput('\x1b[A'); // up arrow

      // Render again to apply scroll
      const lines = widget.render(80);
      // First content line should have scroll indicator
      expect(lines[1]).toContain('up arrow');
    });

    it('scroll offset decreases on down arrow when expanded', () => {
      const widget = new AgentLogWidget(10);
      widget.selectAgent('agent-1', 'coder');
      for (let i = 0; i < 20; i++) {
        widget.addEntry({ type: 'text', content: `entry-${i}` });
      }

      widget.toggleExpand();
      widget.render(80);

      // Scroll up first
      widget.handleInput('\x1b[A'); // up
      widget.render(80);

      // Scroll down
      widget.handleInput('\x1b[B'); // down
      const lines = widget.render(80);

      // After scrolling back down, we should be at bottom (no scroll indicator)
      // The first content line should not contain the scroll indicator
      // But it might have entry content or be empty
      expect(lines[1]).not.toContain('up arrow');
    });

    it('scroll offset clamped at 0', () => {
      const widget = new AgentLogWidget(10);
      widget.selectAgent('agent-1', 'coder');
      widget.toggleExpand();
      widget.render(80);

      // Down arrow when at bottom should stay at 0
      widget.handleInput('\x1b[B'); // down
      widget.render(80);

      // Should remain at bottom (no scroll indicator)
      widget.handleInput('\x1b[B'); // down again
      const lines = widget.render(80);
      expect(lines[1]).not.toContain('up arrow');
    });

    it('scroll offset clamped at max', () => {
      const widget = new AgentLogWidget(10);
      widget.selectAgent('agent-1', 'coder');
      // Add entries to give a limited scroll range (say 42 lines)
      // entrySlots = 39 (single agent, no footer), total = 42 -> maxScrollOffset = 3
      for (let i = 0; i < 42; i++) {
        widget.addEntry({ type: 'text', content: `entry-${i}` });
      }

      widget.toggleExpand();
      widget.render(80);

      // Press up many times — should clamp at maxScrollOffset (42 - 39 = 3)
      for (let i = 0; i < 100; i++) {
        widget.handleInput('\x1b[A'); // up
      }
      const lines = widget.render(80);

      // Should have a scroll indicator showing clamped value
      expect(lines[1]).toContain('up arrow');
      // Max scroll offset is 3 (42-39), so up arrow with 3 lines to show
      expect(lines[1]).toContain('3');
    });
  });

  // ─── Phase navigation via handleInput ───────────────────────────────

  describe('phase navigation via handleInput', () => {
    const CTRL_LEFT = '\x1b[1;5D'; // ctrl+left
    const CTRL_RIGHT = '\x1b[1;5C'; // ctrl+right

    it('ctrl+left switches to previous started phase', () => {
      const widget = new AgentLogWidget(5);
      widget.addStartedPhase('planning');
      widget.addStartedPhase('execution');
      widget.addStartedPhase('review');
      widget.setCurrentPhase('review');

      widget.handleInput(CTRL_LEFT);
      expect(widget.getCurrentPhase()).toBe('execution');

      widget.handleInput(CTRL_LEFT);
      expect(widget.getCurrentPhase()).toBe('planning');
    });

    it('ctrl+right switches to next started phase', () => {
      const widget = new AgentLogWidget(5);
      widget.addStartedPhase('planning');
      widget.addStartedPhase('execution');
      widget.addStartedPhase('review');
      widget.setCurrentPhase('planning');

      widget.handleInput(CTRL_RIGHT);
      expect(widget.getCurrentPhase()).toBe('execution');

      widget.handleInput(CTRL_RIGHT);
      expect(widget.getCurrentPhase()).toBe('review');
    });

    it('ctrl+left/right wraps around', () => {
      const widget = new AgentLogWidget(5);
      widget.addStartedPhase('planning');
      widget.addStartedPhase('execution');
      widget.addStartedPhase('review');
      widget.setCurrentPhase('planning');

      // Ctrl+left from first should wrap to last
      widget.handleInput(CTRL_LEFT);
      expect(widget.getCurrentPhase()).toBe('review');

      // Ctrl+right from last should wrap to first
      widget.handleInput(CTRL_RIGHT);
      expect(widget.getCurrentPhase()).toBe('planning');
    });

    it('ctrl+left/right does nothing with zero or one started phases', () => {
      const widget = new AgentLogWidget(5);
      // No started phases
      widget.handleInput(CTRL_LEFT);
      expect(widget.getCurrentPhase()).toBeNull();

      widget.handleInput(CTRL_RIGHT);
      expect(widget.getCurrentPhase()).toBeNull();

      // One started phase
      widget.addStartedPhase('planning');
      widget.setCurrentPhase('planning');

      widget.handleInput(CTRL_LEFT);
      expect(widget.getCurrentPhase()).toBe('planning');

      widget.handleInput(CTRL_RIGHT);
      expect(widget.getCurrentPhase()).toBe('planning');
    });
  });

  // ─── Agent navigation scoped to phase ───────────────────────────────

  describe('agent navigation scoped to phase', () => {
    it('left/right only cycles agents in current phase', () => {
      const widget = new AgentLogWidget(5);
      // Create agents in different phases
      widget.selectAgentInPhase('p1', 'planning', 'planner');
      widget.selectAgentInPhase('p2', 'planning', 'planner');
      widget.selectAgentInPhase('e1', 'execution', 'executor');
      widget.selectAgentInPhase('e2', 'execution', 'executor');

      // Set current phase to planning and current agent to p1
      widget.setCurrentPhase('planning');
      expect(widget.getCurrentAgentId()).toBe('p1');

      // Right arrow should cycle to p2 (next agent in planning phase)
      widget.handleInput(RIGHT_ARROW);
      expect(widget.getCurrentAgentId()).toBe('p2');

      // Right arrow should wrap to p1
      widget.handleInput(RIGHT_ARROW);
      expect(widget.getCurrentAgentId()).toBe('p1');

      // Should NOT navigate to execution agents
      widget.handleInput(RIGHT_ARROW);
      expect(widget.getCurrentAgentId()).not.toBe('e1');
      expect(widget.getCurrentAgentId()).not.toBe('e2');
    });

    it('left/right falls back to all agents when no phase set', () => {
      const widget = new AgentLogWidget(5);
      widget.selectAgent('agent-1', 'coder');
      widget.selectAgent('agent-2', 'scout');
      widget.selectAgent('agent-3', 'planner');
      // Current is agent-3

      // Left arrow should cycle through all agents (since no phase is set)
      widget.handleInput(LEFT_ARROW);
      expect(widget.getCurrentAgentId()).toBe('agent-2');

      widget.handleInput(LEFT_ARROW);
      expect(widget.getCurrentAgentId()).toBe('agent-1');

      // Wrap around
      widget.handleInput(LEFT_ARROW);
      expect(widget.getCurrentAgentId()).toBe('agent-3');
    });
  });

  // ─── Footer with expand/phase info ──────────────────────────────────

  describe('footer with expand/phase info', () => {
    it('footer contains "Space expand" when collapsed with multiple agents', () => {
      const widget = new AgentLogWidget(5);
      widget.selectAgent('agent-1', 'coder');
      widget.selectAgent('agent-2', 'scout');

      const lines = widget.render(80);
      const footer = lines[lines.length - 1];
      expect(footer).toContain('Space expand');
    });

    it('footer contains "Space collapse" when expanded', () => {
      const widget = new AgentLogWidget(5);
      widget.selectAgent('agent-1', 'coder');
      widget.selectAgent('agent-2', 'scout');
      widget.toggleExpand();

      const lines = widget.render(80);
      const footer = lines[lines.length - 1];
      expect(footer).toContain('Space collapse');
    });

    it('footer contains phase switch hint when multiple started phases exist', () => {
      const widget = new AgentLogWidget(5);
      widget.selectAgent('agent-1', 'coder');
      widget.selectAgent('agent-2', 'scout');
      widget.addStartedPhase('planning');
      widget.addStartedPhase('execution');
      widget.setCurrentPhase('planning');

      const lines = widget.render(80);
      const footer = lines[lines.length - 1];
      expect(footer).toContain('Ctrl+left/right switch phase');
      expect(footer).toContain('[planning]');
    });

    it('footer contains scroll hint when expanded', () => {
      const widget = new AgentLogWidget(5);
      widget.selectAgent('agent-1', 'coder');
      widget.selectAgent('agent-2', 'scout');
      widget.toggleExpand();

      const lines = widget.render(80);
      const footer = lines[lines.length - 1];
      expect(footer).toContain('up/down scroll');
    });
  });
});
