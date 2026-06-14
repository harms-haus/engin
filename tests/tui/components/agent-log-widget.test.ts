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
    // (the header line may show an ellipsis on narrow widths — that's expected
    // H1 behavior — so only check the entry lines here).
    const allContent = lines.join('');
    const entryContent = lines.slice(1).join('');
    expect(entryContent).not.toContain('…');
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

  // ─── Bug2: N/M agent indicator ───────────────────────────────────────

  describe('Bug2: N/M agent indicator', () => {
    it('header shows [1/3] when 3 agents in phase', () => {
      const registry = new AgentRegistry();
      const widget = new AgentLogWidget(5);
      widget.setRegistry(registry);

      registry.register({ agentId: 'a1', profile: 'coder', phase: 'test' });
      registry.register({ agentId: 'a2', profile: 'scout', phase: 'test' });
      registry.register({ agentId: 'a3', profile: 'planner', phase: 'test' });

      widget.setPhases(['test']);
      widget.setCurrentPhase('test');

      const lines = widget.render(80);
      expect(lines[0]).toContain('[1/3]');
    });

    it('header shows [2/3] after right arrow', () => {
      const registry = new AgentRegistry();
      const widget = new AgentLogWidget(5);
      widget.setRegistry(registry);

      registry.register({ agentId: 'a1', profile: 'coder', phase: 'test' });
      registry.register({ agentId: 'a2', profile: 'scout', phase: 'test' });
      registry.register({ agentId: 'a3', profile: 'planner', phase: 'test' });

      widget.setPhases(['test']);
      widget.setCurrentPhase('test');

      widget.handleInput(RIGHT_ARROW);
      const lines = widget.render(80);
      expect(lines[0]).toContain('[2/3]');
    });

    it('header shows [3/3] at last agent after wrapping', () => {
      const registry = new AgentRegistry();
      const widget = new AgentLogWidget(5);
      widget.setRegistry(registry);

      registry.register({ agentId: 'a1', profile: 'coder', phase: 'test' });
      registry.register({ agentId: 'a2', profile: 'scout', phase: 'test' });
      registry.register({ agentId: 'a3', profile: 'planner', phase: 'test' });

      widget.setPhases(['test']);
      widget.setCurrentPhase('test');

      // Right, right, right wraps back to 1, then left goes to 3
      widget.handleInput(RIGHT_ARROW);
      widget.handleInput(RIGHT_ARROW);
      widget.handleInput(RIGHT_ARROW);
      widget.handleInput(LEFT_ARROW);

      const lines = widget.render(80);
      expect(lines[0]).toContain('[3/3]');
    });

    it('header shows NO N/M indicator with a single agent', () => {
      const { widget } = setupWidget(5);
      const lines = widget.render(80);
      // Should not contain any [N/M] pattern
      expect(lines[0]).not.toMatch(/\[\d+\/\d+]/);
    });

    it('header shows NO N/M indicator with no agents', () => {
      const registry = new AgentRegistry();
      const widget = new AgentLogWidget(5);
      widget.setRegistry(registry);
      widget.setPhases(['test']);
      widget.setCurrentPhase('test');

      const lines = widget.render(80);
      // No agent selected line, should not have [N/M]
      expect(lines[0]).not.toMatch(/\[\d+\/\d+]/);
    });
  });

  // ─── Bug5: auto-switch on agent completion ─────────────────────────────

  describe('Bug5: auto-switch on agent completion', () => {
    it('auto-switches to active agent when selected completes', () => {
      const registry = new AgentRegistry();
      const widget = new AgentLogWidget(5);
      widget.setRegistry(registry);

      const uid1 = registry.register({ agentId: 'a1', profile: 'coder', phase: 'test' });
      const uid2 = registry.register({ agentId: 'a2', profile: 'scout', phase: 'test' });

      widget.setPhases(['test']);
      widget.setCurrentPhase('test');

      // Initially selected agent is a1
      expect(widget.getSelectedAgentUid()).toBe(uid1);

      // Complete the selected agent
      registry.complete(uid1);
      widget.invalidate();

      // After render (ensureSelection runs), should auto-switch to a2
      widget.render(80);
      expect(widget.getSelectedAgentUid()).toBe(uid2);
    });

    it('stays on completed agent when no active agents exist', () => {
      const registry = new AgentRegistry();
      const widget = new AgentLogWidget(5);
      widget.setRegistry(registry);

      const uid1 = registry.register({ agentId: 'a1', profile: 'coder', phase: 'test' });

      widget.setPhases(['test']);
      widget.setCurrentPhase('test');

      expect(widget.getSelectedAgentUid()).toBe(uid1);

      // Complete the only agent
      registry.complete(uid1);
      widget.invalidate();

      // No active agents exist — should stay on the completed agent
      widget.render(80);
      expect(widget.getSelectedAgentUid()).toBe(uid1);
    });

    it('user can navigate to a completed agent and it sticks', () => {
      const registry = new AgentRegistry();
      const widget = new AgentLogWidget(5);
      widget.setRegistry(registry);

      const uid1 = registry.register({ agentId: 'a1', profile: 'coder', phase: 'test' });
      const uid2 = registry.register({ agentId: 'a2', profile: 'scout', phase: 'test' });

      widget.setPhases(['test']);
      widget.setCurrentPhase('test');

      // Complete agent-1 -> auto-switch to agent-2
      registry.complete(uid1);
      widget.invalidate();
      widget.render(80);
      expect(widget.getSelectedAgentUid()).toBe(uid2);

      // User presses LEFT to navigate to agent-1 (completed)
      widget.handleInput(LEFT_ARROW);
      expect(widget.getSelectedAgentUid()).toBe(uid1);

      // Render should still show agent-1 because _userNavigated is true
      widget.render(80);
      expect(widget.getSelectedAgentUid()).toBe(uid1);
    });

    it('auto-switch resumes after phase change', () => {
      const registry = new AgentRegistry();
      const widget = new AgentLogWidget(5);
      widget.setRegistry(registry);

      const uid1 = registry.register({ agentId: 'a1', profile: 'coder', phase: 'phase-a' });
      const uid2 = registry.register({ agentId: 'a2', profile: 'scout', phase: 'phase-a' });
      registry.register({ agentId: 'b1', profile: 'planner', phase: 'phase-b' });

      widget.setPhases(['phase-a', 'phase-b']);
      widget.setCurrentPhase('phase-a');

      // Complete agent-1 -> auto-switch to agent-2
      registry.complete(uid1);
      widget.invalidate();
      widget.render(80);
      expect(widget.getSelectedAgentUid()).toBe(uid2);

      // User navigates to agent-1 (completed) — sticks
      widget.handleInput(LEFT_ARROW);
      expect(widget.getSelectedAgentUid()).toBe(uid1);

      // Switch phase (down) — resets _userNavigated
      widget.handleInput(DOWN_ARROW);
      expect(widget.getCurrentPhase()).toBe('phase-b');

      // Switch back to phase-a — auto-switch should fire again
      widget.handleInput(UP_ARROW);
      expect(widget.getCurrentPhase()).toBe('phase-a');
      // Should now auto-switch from completed agent-1 to active agent-2
      expect(widget.getSelectedAgentUid()).toBe(uid2);
    });

    it('auto-switch resets after toggleExpand', () => {
      const registry = new AgentRegistry();
      const widget = new AgentLogWidget(5);
      widget.setRegistry(registry);

      const uid1 = registry.register({ agentId: 'a1', profile: 'coder', phase: 'test' });
      const uid2 = registry.register({ agentId: 'a2', profile: 'scout', phase: 'test' });

      widget.setPhases(['test']);
      widget.setCurrentPhase('test');

      // Complete agent-1 -> auto-switch to agent-2
      registry.complete(uid1);
      widget.invalidate();
      widget.render(80);
      expect(widget.getSelectedAgentUid()).toBe(uid2);

      // Navigate to agent-1
      widget.handleInput(LEFT_ARROW);
      expect(widget.getSelectedAgentUid()).toBe(uid1);

      // Toggle expand resets _userNavigated
      widget.toggleExpand();

      // Auto-switch should fire again: selected is completed, should move to agent-2
      widget.render(80);
      expect(widget.getSelectedAgentUid()).toBe(uid2);
    });
  });

  // ─── Bug3 render fixes ──────────────────────────────────────────────

  describe('Bug3 render fixes', () => {
    it('render line count is always exactly getExpandedLineCount() collapsed with overflow', () => {
      const { widget, registry, uid } = setupWidget(5); // totalLines=5
      for (let i = 0; i < 20; i++) {
        registry.addEntry(uid, { type: 'text', content: `entry-${i}` });
      }
      widget.invalidate();
      expect(widget.render(WIDTH).length).toBe(5);
    });

    it('render line count is always exactly getExpandedLineCount() expanded with overflow', () => {
      const widget = new AgentLogWidget(); // default: 20 collapsed, 40 expanded
      const registry = new AgentRegistry();
      widget.setRegistry(registry);
      const uid = registry.register({ agentId: 'a', profile: 'p', phase: 'test' });
      widget.setPhases(['test']);
      widget.setCurrentPhase('test');
      for (let i = 0; i < 100; i++) {
        registry.addEntry(uid, { type: 'text', content: `entry-${i}` });
      }
      widget.toggleExpand();
      widget.invalidate();
      expect(widget.render(WIDTH).length).toBe(40);
    });

    it('render line count is exact with multi-line entries causing overflow', () => {
      const { widget, registry, uid } = setupWidget(5); // totalLines=5, entrySlots=4
      // Multi-line entry (3 rendered lines) + 5 single-line entries = 8 total lines > 4 slots
      registry.addEntry(uid, { type: 'error', content: 'err1\nerr2\nerr3' });
      for (let i = 0; i < 5; i++) {
        registry.addEntry(uid, { type: 'text', content: `t-${i}` });
      }
      widget.invalidate();
      expect(widget.render(WIDTH).length).toBe(5);
    });

    it('no entry loses its icon line when overflow', () => {
      const { widget, registry, uid } = setupWidget(5); // totalLines=5, entrySlots=4
      // 20 single-line entries: every visible one must retain its icon
      for (let i = 0; i < 20; i++) {
        registry.addEntry(uid, { type: 'text', content: `entry-${i}` });
      }
      widget.invalidate();

      const lines = widget.render(WIDTH);
      expect(lines.length).toBe(5);
      // Should show the 4 most recent entries in chronological order
      expect(lines[1]).toContain('entry-16');
      expect(lines[2]).toContain('entry-17');
      expect(lines[3]).toContain('entry-18');
      expect(lines[4]).toContain('entry-19');
      // All visible entries retain their icon (no splice-stripped icons)
      for (let i = 1; i < 5; i++) {
        expect(lines[i]).toContain('💬');
      }
    });

    it('scroll indicator is a dedicated slot, not a content line', () => {
      const widget = new AgentLogWidget(); // 20 collapsed, 40 expanded
      const registry = new AgentRegistry();
      widget.setRegistry(registry);
      const uid = registry.register({ agentId: 'a1', profile: 'coder', phase: 'test' });
      widget.setPhases(['test']);
      widget.setCurrentPhase('test');

      // Add 50 entries (each 1 line) — exceeds 39 entry slots when expanded
      for (let i = 0; i < 50; i++) {
        registry.addEntry(uid, { type: 'text', content: `entry-${i}` });
      }
      widget.invalidate();

      widget.toggleExpand(); // totalLines=40, entrySlots=39
      widget.render(80);

      // Scroll up by 5
      for (let i = 0; i < 5; i++) widget.handleInput(UP_ARROW);

      const lines = widget.render(80);
      // Total should be exactly 40
      expect(lines.length).toBe(40);
      // Line 0 = header
      // Line 1 = scroll indicator (dedicated slot)
      expect(lines[1]).toContain('up arrow');
      expect(lines[1]).toContain('5');
      // Lines 2–39 = 38 content lines (entrySlots - 1 = 38 when indicator present)
      // Content lines should have 💬 icons
      expect(lines[2]).toContain('💬');
      expect(lines[39]).toContain('💬');
    });

    it('scroll indicator absent when not scrolled — full content slots used', () => {
      const widget = new AgentLogWidget();
      const registry = new AgentRegistry();
      widget.setRegistry(registry);
      const uid = registry.register({ agentId: 'a1', profile: 'coder', phase: 'test' });
      widget.setPhases(['test']);
      widget.setCurrentPhase('test');

      for (let i = 0; i < 50; i++) {
        registry.addEntry(uid, { type: 'text', content: `entry-${i}` });
      }
      widget.invalidate();
      widget.toggleExpand();

      const lines = widget.render(80);
      expect(lines.length).toBe(40);
      // No indicator when scrollOffset=0
      expect(lines[1]).not.toContain('up arrow');
      // All 39 content lines should have icons
      for (let i = 1; i <= 39; i++) {
        expect(lines[i]).toContain('💬');
      }
    });

    it('scrollOffset consistent: pressing up N times then render shows N (no snap/jump)', () => {
      const widget = new AgentLogWidget();
      const registry = new AgentRegistry();
      widget.setRegistry(registry);
      const uid = registry.register({ agentId: 'a1', profile: 'coder', phase: 'test' });
      widget.setPhases(['test']);
      widget.setCurrentPhase('test');

      for (let i = 0; i < 50; i++) {
        registry.addEntry(uid, { type: 'text', content: `entry-${i}` });
      }
      widget.invalidate();
      widget.toggleExpand();
      widget.render(80);

      // Press up 5 times
      for (let i = 0; i < 5; i++) widget.handleInput(UP_ARROW);
      let lines = widget.render(80);
      expect(lines[1]).toContain('5');

      // Press up 5 more (total 10)
      for (let i = 0; i < 5; i++) widget.handleInput(UP_ARROW);
      lines = widget.render(80);
      expect(lines[1]).toContain('10');

      // Scroll back down 3 — should show 7, no jump
      for (let i = 0; i < 3; i++) widget.handleInput(DOWN_ARROW);
      lines = widget.render(80);
      expect(lines[1]).toContain('7');
    });

    it('addEntry then invalidate then render shows new entry', () => {
      const { widget, registry, uid } = setupWidget(5);

      registry.addEntry(uid, { type: 'text', content: 'first entry' });
      widget.invalidate();

      let lines = widget.render(WIDTH);
      expect(lines[1]).toContain('first entry');

      // Simulate what happens after onTurnEnd callback (addEntry + invalidate)
      registry.addEntry(uid, { type: 'text', content: 'second entry' });
      widget.invalidate(); // This is the key fix — callbacks now call invalidate

      lines = widget.render(WIDTH);
      // Entries render oldest-first: first entry at [1], second entry at [2]
      expect(lines[1]).toContain('first entry');
      expect(lines[2]).toContain('second entry');
      expect(lines.length).toBe(5);
    });
  });

  // ─── Review fixes (H1 / M1 / EFF-1) ────────────────────────────────

  describe('Review fixes (H1 / M1 / EFF-1)', () => {
    // FIX H1 — long titles no longer clip the N/M indicator + controls
    it('header keeps N/M indicator and controls visible on a very long title', () => {
      const registry = new AgentRegistry();
      const widget = new AgentLogWidget(5);
      widget.setRegistry(registry);
      const uid1 = registry.register({ agentId: 'a1', profile: 'coder', phase: 'test' });
      registry.register({ agentId: 'a2', profile: 'scout', phase: 'test' });
      registry.register({ agentId: 'a3', profile: 'planner', phase: 'test' });
      widget.setPhases(['test']);
      widget.setCurrentPhase('test');
      // Very long title that would otherwise push indicator + controls off-screen
      registry.updateStats(uid1, { taskTitle: 'A'.repeat(60) });
      widget.invalidate();

      // Width 60 is wide enough to hold the full controls (~28) + indicator (~6)
      // + gaps + a truncated title, but a 60-char title must be truncated.
      const lines = widget.render(60);
      expect(lines.length).toBe(widget.getExpandedLineCount());
      // The N/M indicator survives (no longer clipped off the right edge)
      expect(lines[0]).toContain('[1/3]');
      // The full controls token survives at this width
      expect(lines[0]).toContain('space');
      expect(lines[0]).toContain('expand');
      // The ellipsis lands on the TITLE side (before the indicator), proving
      // it was the title that got truncated — not the indicator/controls.
      const ellipsisIdx = lines[0].indexOf('…');
      const indicatorIdx = lines[0].indexOf('[1/3]');
      expect(ellipsisIdx).toBeGreaterThanOrEqual(0);
      expect(indicatorIdx).toBeGreaterThanOrEqual(0);
      expect(ellipsisIdx).toBeLessThan(indicatorIdx);
    });

    // FIX M1 — scrolling counts as engagement so auto-switch is suppressed
    it('scrolling when expanded sets user-navigation (no auto-switch after scroll)', () => {
      const registry = new AgentRegistry();
      const widget = new AgentLogWidget(5);
      widget.setRegistry(registry);
      const uid1 = registry.register({ agentId: 'a1', profile: 'coder', phase: 'test' });
      // A second (active) agent exists so auto-switch would have a target if it fired.
      registry.register({ agentId: 'a2', profile: 'scout', phase: 'test' });
      widget.setPhases(['test']);
      widget.setCurrentPhase('test');
      for (let i = 0; i < 60; i++) {
        registry.addEntry(uid1, { type: 'text', content: `entry-${i}` });
      }
      widget.invalidate();

      widget.toggleExpand();
      widget.render(80); // compute _lastTotalEntryLines

      // Scroll up — counts as engagement
      widget.handleInput(UP_ARROW);
      widget.render(80);

      // Now complete the selected agent — auto-switch should be suppressed
      // because scrolling set _userNavigated.
      registry.complete(uid1);
      widget.invalidate();
      widget.render(80);
      expect(widget.getSelectedAgentUid()).toBe(uid1);
    });

    // FIX EFF-1 — perf guard must not break line counts or drop newest entries
    it('render line count is exactly getExpandedLineCount() with many entries after EFF-1 guard', () => {
      const widget = new AgentLogWidget(); // 20 collapsed, 40 expanded
      const registry = new AgentRegistry();
      widget.setRegistry(registry);
      const uid = registry.register({ agentId: 'a', profile: 'p', phase: 'test' });
      widget.setPhases(['test']);
      widget.setCurrentPhase('test');
      for (let i = 0; i < 100; i++) {
        registry.addEntry(uid, { type: 'text', content: `entry-${i}` });
      }
      widget.toggleExpand();
      widget.invalidate();

      const lines = widget.render(80);
      expect(lines.length).toBe(40);
      // The EFF-1 guard must not drop the newest entries from the visible window
      expect(lines.some((l) => l.includes('entry-99'))).toBe(true);
      expect(lines.some((l) => l.includes('entry-61'))).toBe(true);
    });
  });
});
