/* eslint-disable no-control-regex -- tests intentionally match ANSI escape codes */
import { describe, expect, it } from 'bun:test';
import { AgentRegistry } from '../../../src/tracking/agent-registry.js';
import { AgentLogWidget } from '../../../src/tui/components/agent-log-widget.js';

const WIDTH = 40;

// Arrow key escape sequences
const LEFT_ARROW = '\x1b[D';
const RIGHT_ARROW = '\x1b[C';
const UP_ARROW = '\x1b[A';
const DOWN_ARROW = '\x1b[B';
const SHIFT_UP = '\x1b[1;2A';
const SHIFT_DOWN = '\x1b[1;2B';

/**
 * Helper: set up a widget with a registry, register an agent in a phase,
 * set the phase and select the agent.
 */
function setupWidget(
  maxLines = 5,
  agentId = 'agent-1',
  profile = 'coder',
  phase = 'test',
): {
  widget: AgentLogWidget;
  registry: AgentRegistry;
  uid: string;
} {
  const registry = new AgentRegistry();
  const widget = new AgentLogWidget(maxLines);
  widget.setRegistry(registry);

  const uid = registry.register({ agentId, profile, phase });
  widget.setPhases([phase]);
  widget.setCurrentPhase(phase);

  return { widget, registry, uid };
}

describe('AgentLogWidget', () => {
  // ─── No agent selected ────────────────────────────────────────────────

  it("renders 'No agent selected' when no agents in current phase", () => {
    const registry = new AgentRegistry();
    const widget = new AgentLogWidget(5);
    widget.setRegistry(registry);
    widget.setPhases(['test']);
    widget.setCurrentPhase('test');

    const lines = widget.render(WIDTH);
    expect(lines.length).toBe(5);
    expect(lines[0]).toContain('No agent selected');
    for (let i = 1; i < 5; i++) {
      expect(lines[i].trim()).toBe('');
    }
  });

  // ─── Header rendering ──────────────────────────────────────────────────

  it('renders header containing title, profile, tool call count, input tokens, output tokens', () => {
    const { widget, registry, uid } = setupWidget(5);
    registry.updateStats(uid, {
      taskTitle: 'Implement X',
      toolCallCount: 3,
      inputTokens: 150,
      outputTokens: 75,
    });

    const lines = widget.render(80);
    expect(lines[0]).toContain('Implement X');
    expect(lines[0]).toContain('profile: coder');
    expect(lines[0]).toContain('3 tool calls');
    expect(lines[0]).toContain('↑150');
    expect(lines[0]).toContain('↓75');
  });

  it('renders controls text right-aligned in header when collapsed', () => {
    const { widget } = setupWidget(5);
    const lines = widget.render(80);
    // Header line should have right-aligned controls
    expect(lines[0]).toContain('↑↓phase ←→agent space expand');
    // Controls should be at the end of the line
    const header = lines[0];
    // After stripping ANSI, the controls text should be near the end
    const stripped = header.replace(/\x1b\[[^a-zA-Z]*[a-zA-Z]/g, '');
    expect(stripped.endsWith('space expand') || stripped.endsWith('space expand ')).toBe(true);
  });

  it('renders controls text right-aligned in header when expanded', () => {
    const { widget } = setupWidget(5);
    widget.toggleExpand();
    const lines = widget.render(80);
    expect(lines[0]).toContain('↑↓scroll x10⇧↑↓ space collapse');
  });

  // ─── NO footer ─────────────────────────────────────────────────────────

  it('NO footer is rendered: no line contains switch agent text', () => {
    const { widget, registry } = setupWidget(5);
    // Register a second agent
    registry.register({ agentId: 'agent-2', profile: 'scout', phase: 'test' });
    widget.invalidate();

    const lines = widget.render(80);
    // No line should contain footer-like text
    for (const line of lines) {
      expect(line).not.toContain('switch agent');
    }
  });

  it('NO footer is rendered: total line count equals header plus entry slots with no footer line', () => {
    const { widget } = setupWidget(3);
    const lines = widget.render(WIDTH);
    expect(lines.length).toBe(3); // header + 2 entry slots (no footer)
  });

  // ─── Entry rendering ────────────────────────────────────────────────────

  it('renders entries with correct type icons', () => {
    const { widget, registry, uid } = setupWidget(5);
    registry.addEntry(uid, { type: 'text', content: 'hello' });
    registry.addEntry(uid, { type: 'thinking', content: 'pondering' });
    registry.addEntry(uid, { type: 'error', content: 'oops' });
    registry.addEntry(uid, { type: 'tool_call_start', content: 'running tool' });
    widget.invalidate();

    const lines = widget.render(WIDTH);
    // lines[0] = header, lines[1-4] = entries
    expect(lines[1]).toContain('💬');
    expect(lines[2]).toContain('🧠');
    expect(lines[3]).toContain('⚠️');
    expect(lines[4]).toContain('🔧');
  });

  it('wraps long content to width', () => {
    const { widget, registry, uid } = setupWidget(5);
    registry.addEntry(uid, {
      type: 'text',
      content: 'This is a very long string that should wrap',
    });
    widget.invalidate();

    // width=20, prefix '  💬 ' has visibleWidth=5, remainingWidth=15
    // wrapTextWithAnsi splits at word boundaries
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
    const { widget, registry, uid } = setupWidget(5);
    registry.addEntry(uid, {
      type: 'text',
      content: 'supercalifragilisticexpialidocious',
    });
    widget.invalidate();

    // width=20, prefix visibleWidth=5, remainingWidth=15
    const lines = widget.render(20);
    expect(lines.length).toBe(5);
    const allContent = lines.join('');
    expect(allContent).toContain('supercalifragil');
    expect(allContent).toContain('isticexpialidoc');
    expect(allContent).toContain('ious');
    // Only the first line should have the icon
    expect(lines[1]).toContain('💬');
    // Continuation lines should have spaces instead of icon
    expect(lines[2]).not.toContain('💬');
  });

  // ─── Line count ─────────────────────────────────────────────────────────

  it('always returns exactly getExpandedLineCount() lines regardless of entry count', () => {
    // Test with 0 entries
    const w1 = new AgentLogWidget(3);
    const r1 = new AgentRegistry();
    w1.setRegistry(r1);
    r1.register({ agentId: 'a', profile: 'p', phase: 'test' });
    w1.setPhases(['test']);
    w1.setCurrentPhase('test');
    expect(w1.render(WIDTH).length).toBe(3);

    // Test with 1 entry
    const w2 = new AgentLogWidget(3);
    const r2 = new AgentRegistry();
    w2.setRegistry(r2);
    const u2 = r2.register({ agentId: 'a', profile: 'p', phase: 'test' });
    w2.setPhases(['test']);
    w2.setCurrentPhase('test');
    r2.addEntry(u2, { type: 'text', content: 'hi' });
    w2.invalidate();
    expect(w2.render(WIDTH).length).toBe(3);

    // Test with more entries than slots
    const w4 = new AgentLogWidget(3);
    const r4 = new AgentRegistry();
    w4.setRegistry(r4);
    const u4 = r4.register({ agentId: 'a', profile: 'p', phase: 'test' });
    w4.setPhases(['test']);
    w4.setCurrentPhase('test');
    r4.addEntry(u4, { type: 'text', content: 'a' });
    r4.addEntry(u4, { type: 'text', content: 'b' });
    r4.addEntry(u4, { type: 'text', content: 'c' });
    r4.addEntry(u4, { type: 'text', content: 'd' });
    w4.invalidate();
    const lines = w4.render(WIDTH);
    expect(lines.length).toBe(3);
    // header + 2 most recent entries (no footer)
    expect(lines[1]).toContain('c');
    expect(lines[2]).toContain('d');
  });

  it('default maxLines is 20 when collapsed, 40 when expanded', () => {
    const widget = new AgentLogWidget();
    const registry = new AgentRegistry();
    widget.setRegistry(registry);
    registry.register({ agentId: 'a', profile: 'p', phase: 'test' });
    widget.setPhases(['test']);
    widget.setCurrentPhase('test');

    // Collapsed: 20 lines
    expect(widget.render(WIDTH).length).toBe(20);

    // Expanded: 40 lines
    widget.toggleExpand();
    expect(widget.render(WIDTH).length).toBe(40);
  });

  // ─── Ring buffer ────────────────────────────────────────────────────────

  it('entry ring buffer caps at 200 entries', () => {
    const registry = new AgentRegistry();
    const widget = new AgentLogWidget(200);
    widget.setRegistry(registry);
    const uid = registry.register({
      agentId: 'agent-2',
      profile: 'coder',
      phase: 'test',
    });
    widget.setPhases(['test']);
    widget.setCurrentPhase('test');

    for (let i = 0; i < 201; i++) {
      registry.addEntry(uid, { type: 'text', content: `entry-${i}` });
    }
    widget.invalidate();

    const lines = widget.render(80);

    // After adding 201 entries, entry-0 was shifted (registry caps at 200)
    // entries[0] (entry-0) was shifted when count went from 200→201
    // With maxLines=200, visibleCount=199, startIdx = max(0, 200-199) = 1
    // So the first visible entry is entries[1] which is original entry-2
    expect(lines[1]).toContain('entry-2');
    // Last entry should be entry-200
    expect(lines[199]).toContain('entry-200');
    // Header + 199 visible entries = 200 lines total
    expect(lines.length).toBe(200);
  });

  // ─── Left/right navigation ─────────────────────────────────────────────

  it('left/right cycles agents within current phase with wrapping', () => {
    const registry = new AgentRegistry();
    const widget = new AgentLogWidget(5);
    widget.setRegistry(registry);

    registry.register({ agentId: 'agent-1', profile: 'coder', phase: 'test' });
    registry.register({ agentId: 'agent-2', profile: 'scout', phase: 'test' });
    registry.register({ agentId: 'agent-3', profile: 'planner', phase: 'test' });

    widget.setPhases(['test']);
    widget.setCurrentPhase('test');
    // Selected agent index = 0 -> agent-1 uid

    // Right arrow goes to agent-2
    widget.handleInput(RIGHT_ARROW);
    expect(widget.getSelectedAgentUid()).toBe(registry.getActiveUid('agent-2'));

    // Right arrow goes to agent-3
    widget.handleInput(RIGHT_ARROW);
    expect(widget.getSelectedAgentUid()).toBe(registry.getActiveUid('agent-3'));

    // Right arrow wraps to agent-1
    widget.handleInput(RIGHT_ARROW);
    expect(widget.getSelectedAgentUid()).toBe(registry.getActiveUid('agent-1'));

    // Left arrow wraps to agent-3
    widget.handleInput(LEFT_ARROW);
    expect(widget.getSelectedAgentUid()).toBe(registry.getActiveUid('agent-3'));
  });

  it('left/right does NOT cross phase boundaries', () => {
    const registry = new AgentRegistry();
    const widget = new AgentLogWidget(5);
    widget.setRegistry(registry);

    // Register agents in different phases
    registry.register({ agentId: 'p1', profile: 'planner', phase: 'planning' });
    registry.register({ agentId: 'p2', profile: 'planner', phase: 'planning' });
    registry.register({ agentId: 'e1', profile: 'executor', phase: 'execution' });
    registry.register({ agentId: 'e2', profile: 'executor', phase: 'execution' });

    widget.setPhases(['planning', 'execution']);
    widget.setCurrentPhase('planning');

    const p1Uid = registry.getActiveUid('p1');
    const p2Uid = registry.getActiveUid('p2');
    const e1Uid = registry.getActiveUid('e1');

    // In planning phase, should only cycle between p1 and p2
    expect(widget.getSelectedAgentUid()).toBe(p1Uid);

    widget.handleInput(RIGHT_ARROW);
    expect(widget.getSelectedAgentUid()).toBe(p2Uid);

    widget.handleInput(RIGHT_ARROW);
    expect(widget.getSelectedAgentUid()).toBe(p1Uid); // wrapped within planning

    // Should NOT reach execution agents
    expect(widget.getSelectedAgentUid()).not.toBe(e1Uid);
  });

  it('left/right does nothing with single agent in phase', () => {
    const { widget } = setupWidget(5);
    const uid = widget.getSelectedAgentUid();

    widget.handleInput(LEFT_ARROW);
    expect(widget.getSelectedAgentUid()).toBe(uid);

    widget.handleInput(RIGHT_ARROW);
    expect(widget.getSelectedAgentUid()).toBe(uid);
  });

  it('left/right does nothing with no agents in phase', () => {
    const registry = new AgentRegistry();
    const widget = new AgentLogWidget(5);
    widget.setRegistry(registry);
    widget.setPhases(['test']);
    widget.setCurrentPhase('test');

    expect(widget.getSelectedAgentUid()).toBeNull();

    widget.handleInput(LEFT_ARROW);
    expect(widget.getSelectedAgentUid()).toBeNull();

    widget.handleInput(RIGHT_ARROW);
    expect(widget.getSelectedAgentUid()).toBeNull();
  });

  // ─── Up/down cycles phases ─────────────────────────────────────────────

  it('up/down cycles WORKFLOW phases with wrapping', () => {
    const registry = new AgentRegistry();
    const widget = new AgentLogWidget(5);
    widget.setRegistry(registry);

    registry.register({ agentId: 'a1', profile: 'p1', phase: 'phase-a' });
    registry.register({ agentId: 'a2', profile: 'p2', phase: 'phase-b' });
    registry.register({ agentId: 'a3', profile: 'p3', phase: 'phase-c' });

    widget.setPhases(['phase-a', 'phase-b', 'phase-c']);
    widget.setCurrentPhase('phase-a');

    // Down arrow goes to phase-b
    widget.handleInput(DOWN_ARROW);
    expect(widget.getCurrentPhase()).toBe('phase-b');

    // Down arrow goes to phase-c
    widget.handleInput(DOWN_ARROW);
    expect(widget.getCurrentPhase()).toBe('phase-c');

    // Down arrow wraps to phase-a
    widget.handleInput(DOWN_ARROW);
    expect(widget.getCurrentPhase()).toBe('phase-a');

    // Up arrow wraps to phase-c
    widget.handleInput(UP_ARROW);
    expect(widget.getCurrentPhase()).toBe('phase-c');

    // Up arrow goes to phase-b
    widget.handleInput(UP_ARROW);
    expect(widget.getCurrentPhase()).toBe('phase-b');
  });

  it('up/down resets selectedAgentIndex to 0 on phase change', () => {
    const registry = new AgentRegistry();
    const widget = new AgentLogWidget(5);
    widget.setRegistry(registry);

    registry.register({ agentId: 'a1', profile: 'p1', phase: 'phase-a' });
    registry.register({ agentId: 'a2', profile: 'p1', phase: 'phase-a' });
    registry.register({ agentId: 'b1', profile: 'p2', phase: 'phase-b' });

    widget.setPhases(['phase-a', 'phase-b']);
    widget.setCurrentPhase('phase-a');

    const a1Uid = registry.getActiveUid('a1');
    const a2Uid = registry.getActiveUid('a2');
    const b1Uid = registry.getActiveUid('b1');

    // Start with agent-1 in phase-a
    expect(widget.getSelectedAgentUid()).toBe(a1Uid);

    // Move to agent-2 in phase-a
    widget.handleInput(RIGHT_ARROW);
    expect(widget.getSelectedAgentUid()).toBe(a2Uid);

    // Switch to phase-b — selectedAgentIndex resets to 0
    widget.handleInput(DOWN_ARROW);
    expect(widget.getCurrentPhase()).toBe('phase-b');
    expect(widget.getSelectedAgentUid()).toBe(b1Uid);

    // Switch back to phase-a — selectedAgentIndex resets to 0
    widget.handleInput(UP_ARROW);
    expect(widget.getCurrentPhase()).toBe('phase-a');
    expect(widget.getSelectedAgentUid()).toBe(a1Uid);
  });

  // ─── Expand/collapse ───────────────────────────────────────────────────

  it('toggleExpand toggles expand/collapse state', () => {
    const widget = new AgentLogWidget(5);
    expect(widget.isExpanded()).toBe(false);
    widget.toggleExpand();
    expect(widget.isExpanded()).toBe(true);
    widget.toggleExpand();
    expect(widget.isExpanded()).toBe(false);
  });

  // ─── Scroll when expanded ──────────────────────────────────────────────

  it('when expanded: up scrols by 1 line (scroll indicator appears)', () => {
    const { widget, registry, uid } = setupWidget(10);
    // Add enough entries to allow scrolling
    for (let i = 0; i < 45; i++) {
      registry.addEntry(uid, { type: 'text', content: `entry-${i}` });
    }
    widget.invalidate();

    widget.toggleExpand();

    // Render to compute _lastTotalEntryLines
    widget.render(80);

    // Up arrow should increase scroll offset
    widget.handleInput(UP_ARROW);

    // Render again to apply scroll
    const lines = widget.render(80);
    // First content line should have scroll indicator
    expect(lines[1]).toContain('up arrow');
    expect(lines[1]).toContain('more lines');
  });

  it('when expanded: down scrols by 1 line', () => {
    const { widget, registry, uid } = setupWidget(10);
    for (let i = 0; i < 20; i++) {
      registry.addEntry(uid, { type: 'text', content: `entry-${i}` });
    }
    widget.invalidate();

    widget.toggleExpand();
    widget.render(80);

    // Scroll up first
    widget.handleInput(UP_ARROW);
    widget.render(80);

    // Scroll down
    widget.handleInput(DOWN_ARROW);
    const lines = widget.render(80);

    // After scrolling back down, we should be at bottom (no scroll indicator)
    expect(lines[1]).not.toContain('up arrow');
  });

  it('when expanded: shift+up scrols by 10 lines', () => {
    const { widget, registry, uid } = setupWidget(10);
    // Add many entries so we can scroll a lot
    for (let i = 0; i < 60; i++) {
      registry.addEntry(uid, { type: 'text', content: `entry-${i}` });
    }
    widget.invalidate();

    widget.toggleExpand();
    widget.render(80);

    // Shift+up should scroll by 10
    widget.handleInput(SHIFT_UP);
    const lines = widget.render(80);
    expect(lines[1]).toContain('up arrow');
    // The scroll offset should be 10
    expect(lines[1]).toContain('10');
  });

  it('when expanded: shift+down scrols by 10 lines', () => {
    const { widget, registry, uid } = setupWidget(10);
    for (let i = 0; i < 60; i++) {
      registry.addEntry(uid, { type: 'text', content: `entry-${i}` });
    }
    widget.invalidate();

    widget.toggleExpand();
    widget.render(80);

    // Scroll up by 20
    widget.handleInput(SHIFT_UP);
    widget.handleInput(SHIFT_UP);
    widget.render(80);

    // Scroll down by 10
    widget.handleInput(SHIFT_DOWN);
    const lines = widget.render(80);
    // Should now be at offset 10
    expect(lines[1]).toContain('10');
  });

  it('scroll offset clamped at 0 (bottom)', () => {
    const { widget } = setupWidget(10);
    widget.toggleExpand();
    widget.render(80);

    // Down arrow when at bottom should stay at 0
    widget.handleInput(DOWN_ARROW);
    widget.render(80);

    // Should remain at bottom (no scroll indicator)
    widget.handleInput(DOWN_ARROW);
    const lines = widget.render(80);
    expect(lines[1]).not.toContain('up arrow');
  });

  it('scroll offset clamped at max (top)', () => {
    const { widget, registry, uid } = setupWidget(10);
    // Add entries to give a limited scroll range (42 lines)
    // entrySlots = 39 (single agent, no footer), total = 42 -> maxScrollOffset = 3
    for (let i = 0; i < 42; i++) {
      registry.addEntry(uid, { type: 'text', content: `entry-${i}` });
    }
    widget.invalidate();

    widget.toggleExpand();
    widget.render(80);

    // Press up many times — should clamp at maxScrollOffset (42 - 39 = 3)
    for (let i = 0; i < 100; i++) {
      widget.handleInput(UP_ARROW);
    }
    const lines = widget.render(80);

    // Should have a scroll indicator showing clamped value
    expect(lines[1]).toContain('up arrow');
    // Max scroll offset is 3 (42-39)
    expect(lines[1]).toContain('3');
  });

  it('scroll indicator disappears when scrolled back to bottom', () => {
    const { widget, registry, uid } = setupWidget(10);
    for (let i = 0; i < 45; i++) {
      registry.addEntry(uid, { type: 'text', content: `entry-${i}` });
    }
    widget.invalidate();

    widget.toggleExpand();
    widget.render(80);

    // Scroll up
    widget.handleInput(UP_ARROW);
    let lines = widget.render(80);
    expect(lines[1]).toContain('up arrow');

    // Scroll back to bottom
    widget.handleInput(DOWN_ARROW);
    lines = widget.render(80);
    expect(lines[1]).not.toContain('up arrow');
  });

  // ─── hasPhases / getCurrentPhase / getSelectedAgentUid ──────────────────

  it('hasPhases() returns true when phases are set, false when empty', () => {
    const widget = new AgentLogWidget(5);
    expect(widget.hasPhases()).toBe(false);

    widget.setPhases(['test']);
    expect(widget.hasPhases()).toBe(true);

    widget.setPhases([]);
    expect(widget.hasPhases()).toBe(false);
  });

  it('getCurrentPhase() returns the current phase string or null', () => {
    const widget = new AgentLogWidget(5);
    expect(widget.getCurrentPhase()).toBeNull();

    widget.setPhases(['planning', 'execution']);
    widget.setCurrentPhase('planning');
    expect(widget.getCurrentPhase()).toBe('planning');

    widget.setCurrentPhase('execution');
    expect(widget.getCurrentPhase()).toBe('execution');
  });

  it('getSelectedAgentUid() returns the selected agent UID or null', () => {
    const registry = new AgentRegistry();
    const widget = new AgentLogWidget(5);
    widget.setRegistry(registry);

    // No agents in phase
    widget.setPhases(['test']);
    widget.setCurrentPhase('test');
    expect(widget.getSelectedAgentUid()).toBeNull();

    // Register an agent
    const uid = registry.register({
      agentId: 'agent-1',
      profile: 'coder',
      phase: 'test',
    });
    widget.invalidate();
    expect(widget.getSelectedAgentUid()).toBe(uid);
  });

  // ─── Header shows updated stats ────────────────────────────────────────

  it('header shows updated stats after calling registry.updateStats', () => {
    const { widget, registry, uid } = setupWidget(5);
    registry.updateStats(uid, {
      taskTitle: 'Refactor module',
      toolCallCount: 5,
      inputTokens: 500,
      outputTokens: 200,
    });
    widget.invalidate();

    const lines = widget.render(80);
    expect(lines[0]).toContain('Refactor module');
    expect(lines[0]).toContain('profile: coder');
    expect(lines[0]).toContain('5 tool calls');
    expect(lines[0]).toContain('↑500');
    expect(lines[0]).toContain('↓200');
  });

  it('header uses profile as fallback title when taskTitle is empty', () => {
    const { widget } = setupWidget(5);
    const lines = widget.render(WIDTH);
    expect(lines[0]).toContain('coder');
  });

  it('header uses uid as fallback when both taskTitle and profile are empty', () => {
    const registry = new AgentRegistry();
    const widget = new AgentLogWidget(5);
    widget.setRegistry(registry);
    const uid = registry.register({
      agentId: 'custom-agent',
      profile: '',
      phase: 'test',
    });
    widget.setPhases(['test']);
    widget.setCurrentPhase('test');

    const lines = widget.render(WIDTH);
    expect(lines[0]).toContain(uid);
  });

  // ─── Multi-line entries ────────────────────────────────────────────────

  it('splits multi-line entries into separate rendered lines', () => {
    const { widget, registry, uid } = setupWidget(10);
    registry.addEntry(uid, {
      type: 'thinking',
      content: 'line1\nline2\nline3',
    });
    widget.invalidate();

    const lines = widget.render(WIDTH);
    expect(lines.length).toBe(10);
    expect(lines[1]).toContain('🧠');
    expect(lines[1]).toContain('line1');
    // Continuation lines should NOT have the icon
    expect(lines[2]).toContain('line2');
    expect(lines[2]).not.toContain('🧠');
    expect(lines[3]).toContain('line3');
    expect(lines[3]).not.toContain('🧠');
  });

  it('continuation lines have aligned prefix with no icon', () => {
    const { widget, registry, uid } = setupWidget(10);
    registry.addEntry(uid, {
      type: 'error',
      content: 'msg1\nmsg2',
    });
    widget.invalidate();

    const lines = widget.render(WIDTH);
    expect(lines[1]).toContain('⚠️');
    expect(lines[1]).toContain('msg1');
    expect(lines[2]).toContain('msg2');
    expect(lines[2]).not.toContain('⚠️');
  });

  // ─── setPhases / setCurrentPhase edge cases ─────────────────────────────

  it('setCurrentPhase adds phase if not already in list', () => {
    const widget = new AgentLogWidget(5);
    widget.setPhases(['planning']);

    widget.setCurrentPhase('execution');
    expect(widget.getCurrentPhase()).toBe('execution');
    // 'execution' should now be in the phases list
    expect(widget.hasPhases()).toBe(true);
  });

  it('setCurrentPhase does not duplicate phases', () => {
    const widget = new AgentLogWidget(5);
    widget.setPhases(['planning', 'execution']);
    widget.setCurrentPhase('planning');
    expect(widget.getCurrentPhase()).toBe('planning');

    // Set same phase again
    widget.setCurrentPhase('planning');
    expect(widget.getCurrentPhase()).toBe('planning');
    // Phases list should not have duplicates
    widget.setCurrentPhase('planning');
    // Just ensure no crash and phase stays
    expect(widget.getCurrentPhase()).toBe('planning');
  });

  it('setPhases clamps currentPhaseIndex when shrinking phases', () => {
    const widget = new AgentLogWidget(5);
    widget.setPhases(['a', 'b', 'c']);
    widget.setCurrentPhase('c');
    expect(widget.getCurrentPhase()).toBe('c');

    // Remove 'c' from phases
    widget.setPhases(['a', 'b']);
    expect(widget.getCurrentPhase()).toBe('b'); // clamped to last

    // Remove all phases
    widget.setPhases([]);
    expect(widget.getCurrentPhase()).toBeNull();
  });

  // ─── Toggle expand resets scroll ────────────────────────────────────────

  it('toggleExpand resets scrollOffset to 0', () => {
    const { widget, registry, uid } = setupWidget(10);
    for (let i = 0; i < 45; i++) {
      registry.addEntry(uid, { type: 'text', content: `entry-${i}` });
    }
    widget.invalidate();

    widget.toggleExpand();
    widget.render(80);

    // Scroll up
    widget.handleInput(UP_ARROW);
    widget.render(80);

    // Toggle collapse (resets scroll)
    widget.toggleExpand();
    expect(widget.isExpanded()).toBe(false);

    // Toggle expand again (scroll should be 0)
    widget.toggleExpand();
    const lines = widget.render(80);
    // Should be at bottom (no scroll indicator)
    expect(lines[1]).not.toContain('up arrow');
  });
});
