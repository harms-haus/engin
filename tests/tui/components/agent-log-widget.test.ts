/* eslint-disable no-control-regex -- tests intentionally match ANSI escape codes */
import { describe, expect, it } from 'bun:test';
import type { AgentEntity } from '../../../src/tracking/event-types.js';
import { AgentLogWidget } from '../../../src/tui/components/agent-log-widget.js';

const WIDTH = 40;

// Arrow key escape sequences
const LEFT_ARROW = '\x1b[D';
const RIGHT_ARROW = '\x1b[C';
const UP_ARROW = '\x1b[A';
const DOWN_ARROW = '\x1b[B';
const SHIFT_UP = '\x1b[1;2A';
const SHIFT_DOWN = '\x1b[1;2B';

// ─── AgentEntity helpers ──────────────────────────────────────────────────────

let _uidCounter = 0;

function makeAgent(overrides: Partial<AgentEntity> & Pick<AgentEntity, 'agentId' | 'phase'>): AgentEntity {
  _uidCounter++;
  return {
    uid: overrides.uid ?? overrides.agentId + '-' + _uidCounter,
    agentId: overrides.agentId,
    profile: overrides.profile ?? 'coder',
    phase: overrides.phase,
    active: overrides.active ?? true,
    log: overrides.log ?? [],
    toolCallCount: overrides.toolCallCount ?? 0,
    inputTokens: overrides.inputTokens ?? 0,
    outputTokens: overrides.outputTokens ?? 0,
    taskTitle: overrides.taskTitle ?? '',
    completedAt: overrides.completedAt,
    ...overrides,
  };
}

function resetUidCounter() {
  _uidCounter = 0;
}

/**
 * Helper: set up a widget with agents, register an agent in a phase,
 * set the phase and select the agent.
 */
function setupWidget(
  maxLines = 5,
  agentId = 'agent-1',
  profile = 'coder',
  phase = 'test',
): {
  widget: AgentLogWidget;
  agents: AgentEntity[];
  uid: string;
} {
  resetUidCounter();
  const agents: AgentEntity[] = [];
  const widget = new AgentLogWidget(maxLines);

  const entity = makeAgent({ agentId, profile, phase });
  agents.push(entity);
  widget.setAgents(agents);
  widget.setPhases([phase]);
  widget.setCurrentPhase(phase);

  return { widget, agents, uid: entity.uid };
}

describe('AgentLogWidget', () => {
  // ─── No agent selected ────────────────────────────────────────────────

  it("renders 'No agent selected' when no agents in current phase", () => {
    const widget = new AgentLogWidget(5);
    widget.setAgents([]);
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
    const { widget, agents, uid } = setupWidget(5);
    const agent = agents.find((a) => a.uid === uid)!;
    agent.taskTitle = 'Implement X';
    agent.toolCallCount = 3;
    agent.inputTokens = 150;
    agent.outputTokens = 75;
    widget.invalidate();

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
    const { widget, agents } = setupWidget(5);
    // Add a second agent
    agents.push(makeAgent({ agentId: 'agent-2', profile: 'scout', phase: 'test' }));
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
    const { widget, agents, uid } = setupWidget(5);
    const agent = agents.find((a) => a.uid === uid)!;
    agent.log.push({ id: '1', timestamp: '', type: 'text', content: 'hello' });
    agent.log.push({ id: '2', timestamp: '', type: 'thinking', content: 'pondering' });
    agent.log.push({ id: '3', timestamp: '', type: 'error', content: 'oops' });
    agent.log.push({ id: '4', timestamp: '', type: 'tool_call_start', content: 'running tool' });
    widget.invalidate();

    const lines = widget.render(WIDTH);
    // lines[0] = header, lines[1-4] = entries
    expect(lines[1]).toContain('💬');
    expect(lines[2]).toContain('🧠');
    expect(lines[3]).toContain('⚠️');
    expect(lines[4]).toContain('🔧');
  });

  it('wraps long content to width', () => {
    const { widget, agents, uid } = setupWidget(5);
    const agent = agents.find((a) => a.uid === uid)!;
    agent.log.push({ id: '1', timestamp: '', type: 'text', content: 'This is a very long string that should wrap' });
    widget.invalidate();

    // width=20, prefix '  💬 ' has visibleWidth=5, remainingWidth=15
    const lines = widget.render(20);
    expect(lines.length).toBe(5);
    const entryContent = lines.slice(1).join('');
    expect(entryContent).not.toContain('…');
    const entryLines = lines.slice(1).filter((l) => l.trim().length > 0);
    expect(entryLines.length).toBeGreaterThan(1);
    expect(lines.join('')).toContain('This is a very');
    expect(lines.join('')).toContain('long string');
    expect(lines.join('')).toContain('that should');
    expect(lines.join('')).toContain('wrap');
  });

  it('wraps a very long single word', () => {
    const { widget, agents, uid } = setupWidget(5);
    const agent = agents.find((a) => a.uid === uid)!;
    agent.log.push({ id: '1', timestamp: '', type: 'text', content: 'supercalifragilisticexpialidocious' });
    widget.invalidate();

    const lines = widget.render(20);
    expect(lines.length).toBe(5);
    const allContent = lines.join('');
    expect(allContent).toContain('supercalifragil');
    expect(allContent).toContain('isticexpialidoc');
    expect(allContent).toContain('ious');
    expect(lines[1]).toContain('💬');
    expect(lines[2]).not.toContain('💬');
  });

  // ─── Line count ─────────────────────────────────────────────────────────

  it('always returns exactly getExpandedLineCount() lines regardless of entry count', () => {
    // Test with 0 entries
    const w1 = new AgentLogWidget(3);
    const r1: AgentEntity[] = [makeAgent({ agentId: 'a', profile: 'p', phase: 'test' })];
    w1.setAgents(r1);
    w1.setPhases(['test']);
    w1.setCurrentPhase('test');
    expect(w1.render(WIDTH).length).toBe(3);

    // Test with 1 entry
    const w2 = new AgentLogWidget(3);
    const u2e = makeAgent({ agentId: 'a', profile: 'p', phase: 'test' });
    u2e.log.push({ id: '1', timestamp: '', type: 'text', content: 'hi' });
    w2.setAgents([u2e]);
    w2.setPhases(['test']);
    w2.setCurrentPhase('test');
    expect(w2.render(WIDTH).length).toBe(3);

    // Test with more entries than slots
    const w4 = new AgentLogWidget(3);
    const u4e = makeAgent({ agentId: 'a', profile: 'p', phase: 'test' });
    for (const c of ['a', 'b', 'c', 'd']) {
      u4e.log.push({ id: '1', timestamp: '', type: 'text', content: c });
    }
    w4.setAgents([u4e]);
    w4.setPhases(['test']);
    w4.setCurrentPhase('test');
    const lines = w4.render(WIDTH);
    expect(lines.length).toBe(3);
    // header + 2 most recent entries (no footer)
    expect(lines[1]).toContain('c');
    expect(lines[2]).toContain('d');
  });

  it('default maxLines is 20 when collapsed, 40 when expanded', () => {
    const widget = new AgentLogWidget();
    const agents = [makeAgent({ agentId: 'a', profile: 'p', phase: 'test' })];
    widget.setAgents(agents);
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
    const widget = new AgentLogWidget(200);
    const agent = makeAgent({ agentId: 'agent-2', profile: 'coder', phase: 'test' });
    widget.setAgents([agent]);
    widget.setPhases(['test']);
    widget.setCurrentPhase('test');

    for (let i = 0; i < 201; i++) {
      agent.log.push({ id: `${i}`, timestamp: '', type: 'text', content: `entry-${i}` });
    }
    widget.invalidate();

    const lines = widget.render(80);

    // After adding 201 entries, entry-0 was shifted (cap at 200)
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
    const widget = new AgentLogWidget(5);
    const a1 = makeAgent({ agentId: 'agent-1', profile: 'coder', phase: 'test' });
    const a2 = makeAgent({ agentId: 'agent-2', profile: 'scout', phase: 'test' });
    const a3 = makeAgent({ agentId: 'agent-3', profile: 'planner', phase: 'test' });

    widget.setAgents([a1, a2, a3]);
    widget.setPhases(['test']);
    widget.setCurrentPhase('test');

    // Right arrow goes to agent-2
    widget.handleInput(RIGHT_ARROW);
    expect(widget.getSelectedAgentUid()).toBe(a2.uid);

    // Right arrow goes to agent-3
    widget.handleInput(RIGHT_ARROW);
    expect(widget.getSelectedAgentUid()).toBe(a3.uid);

    // Right arrow wraps to agent-1
    widget.handleInput(RIGHT_ARROW);
    expect(widget.getSelectedAgentUid()).toBe(a1.uid);

    // Left arrow wraps to agent-3
    widget.handleInput(LEFT_ARROW);
    expect(widget.getSelectedAgentUid()).toBe(a3.uid);
  });

  it('left/right does NOT cross phase boundaries', () => {
    const widget = new AgentLogWidget(5);
    const p1 = makeAgent({ agentId: 'p1', profile: 'planner', phase: 'planning' });
    const p2 = makeAgent({ agentId: 'p2', profile: 'planner', phase: 'planning' });
    const e1 = makeAgent({ agentId: 'e1', profile: 'executor', phase: 'execution' });
    const e2 = makeAgent({ agentId: 'e2', profile: 'executor', phase: 'execution' });

    widget.setAgents([p1, p2, e1, e2]);
    widget.setPhases(['planning', 'execution']);
    widget.setCurrentPhase('planning');

    // In planning phase, should only cycle between p1 and p2
    expect(widget.getSelectedAgentUid()).toBe(p1.uid);

    widget.handleInput(RIGHT_ARROW);
    expect(widget.getSelectedAgentUid()).toBe(p2.uid);

    widget.handleInput(RIGHT_ARROW);
    expect(widget.getSelectedAgentUid()).toBe(p1.uid); // wrapped within planning

    // Should NOT reach execution agents
    expect(widget.getSelectedAgentUid()).not.toBe(e1.uid);
  });

  it('left/right does nothing with single agent in phase', () => {
    const { widget, uid } = setupWidget(5);

    widget.handleInput(LEFT_ARROW);
    expect(widget.getSelectedAgentUid()).toBe(uid);

    widget.handleInput(RIGHT_ARROW);
    expect(widget.getSelectedAgentUid()).toBe(uid);
  });

  it('left/right does nothing with no agents in phase', () => {
    const widget = new AgentLogWidget(5);
    widget.setAgents([]);
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
    const widget = new AgentLogWidget(5);
    const a1 = makeAgent({ agentId: 'a1', profile: 'p1', phase: 'phase-a' });
    const a2 = makeAgent({ agentId: 'a2', profile: 'p2', phase: 'phase-b' });
    const a3 = makeAgent({ agentId: 'a3', profile: 'p3', phase: 'phase-c' });

    widget.setAgents([a1, a2, a3]);
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
    const widget = new AgentLogWidget(5);
    const a1 = makeAgent({ agentId: 'a1', profile: 'p1', phase: 'phase-a' });
    const a2 = makeAgent({ agentId: 'a2', profile: 'p1', phase: 'phase-a' });
    const b1 = makeAgent({ agentId: 'b1', profile: 'p2', phase: 'phase-b' });

    widget.setAgents([a1, a2, b1]);
    widget.setPhases(['phase-a', 'phase-b']);
    widget.setCurrentPhase('phase-a');

    // Start with agent-1 in phase-a
    expect(widget.getSelectedAgentUid()).toBe(a1.uid);

    // Move to agent-2 in phase-a
    widget.handleInput(RIGHT_ARROW);
    expect(widget.getSelectedAgentUid()).toBe(a2.uid);

    // Switch to phase-b — selectedAgentIndex resets to 0
    widget.handleInput(DOWN_ARROW);
    expect(widget.getCurrentPhase()).toBe('phase-b');
    expect(widget.getSelectedAgentUid()).toBe(b1.uid);

    // Switch back to phase-a — selectedAgentIndex resets to 0
    widget.handleInput(UP_ARROW);
    expect(widget.getCurrentPhase()).toBe('phase-a');
    expect(widget.getSelectedAgentUid()).toBe(a1.uid);
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
    const { widget, agents, uid } = setupWidget(10);
    const agent = agents.find((a) => a.uid === uid)!;
    for (let i = 0; i < 45; i++) {
      agent.log.push({ id: `${i}`, timestamp: '', type: 'text', content: `entry-${i}` });
    }
    widget.invalidate();

    widget.toggleExpand();
    widget.render(80);

    widget.handleInput(UP_ARROW);
    const lines = widget.render(80);
    expect(lines[1]).toContain('up arrow');
    expect(lines[1]).toContain('more lines');
  });

  it('when expanded: down scrols by 1 line', () => {
    const { widget, agents, uid } = setupWidget(10);
    const agent = agents.find((a) => a.uid === uid)!;
    for (let i = 0; i < 20; i++) {
      agent.log.push({ id: `${i}`, timestamp: '', type: 'text', content: `entry-${i}` });
    }
    widget.invalidate();

    widget.toggleExpand();
    widget.render(80);

    widget.handleInput(UP_ARROW);
    widget.render(80);

    widget.handleInput(DOWN_ARROW);
    const lines = widget.render(80);
    expect(lines[1]).not.toContain('up arrow');
  });

  it('when expanded: shift+up scrols by 10 lines', () => {
    const { widget, agents, uid } = setupWidget(10);
    const agent = agents.find((a) => a.uid === uid)!;
    for (let i = 0; i < 60; i++) {
      agent.log.push({ id: `${i}`, timestamp: '', type: 'text', content: `entry-${i}` });
    }
    widget.invalidate();

    widget.toggleExpand();
    widget.render(80);

    widget.handleInput(SHIFT_UP);
    const lines = widget.render(80);
    expect(lines[1]).toContain('up arrow');
    expect(lines[1]).toContain('10');
  });

  it('when expanded: shift+down scrols by 10 lines', () => {
    const { widget, agents, uid } = setupWidget(10);
    const agent = agents.find((a) => a.uid === uid)!;
    for (let i = 0; i < 60; i++) {
      agent.log.push({ id: `${i}`, timestamp: '', type: 'text', content: `entry-${i}` });
    }
    widget.invalidate();

    widget.toggleExpand();
    widget.render(80);

    widget.handleInput(SHIFT_UP);
    widget.handleInput(SHIFT_UP);
    widget.render(80);

    widget.handleInput(SHIFT_DOWN);
    const lines = widget.render(80);
    expect(lines[1]).toContain('10');
  });

  it('scroll offset clamped at 0 (bottom)', () => {
    const { widget } = setupWidget(10);
    widget.toggleExpand();
    widget.render(80);

    widget.handleInput(DOWN_ARROW);
    widget.render(80);

    widget.handleInput(DOWN_ARROW);
    const lines = widget.render(80);
    expect(lines[1]).not.toContain('up arrow');
  });

  it('scroll offset clamped at max (top)', () => {
    const { widget, agents, uid } = setupWidget(10);
    const agent = agents.find((a) => a.uid === uid)!;
    for (let i = 0; i < 42; i++) {
      agent.log.push({ id: `${i}`, timestamp: '', type: 'text', content: `entry-${i}` });
    }
    widget.invalidate();

    widget.toggleExpand();
    widget.render(80);

    for (let i = 0; i < 100; i++) {
      widget.handleInput(UP_ARROW);
    }
    const lines = widget.render(80);
    expect(lines[1]).toContain('up arrow');
    expect(lines[1]).toContain('3');
  });

  it('scroll indicator disappears when scrolled back to bottom', () => {
    const { widget, agents, uid } = setupWidget(10);
    const agent = agents.find((a) => a.uid === uid)!;
    for (let i = 0; i < 45; i++) {
      agent.log.push({ id: `${i}`, timestamp: '', type: 'text', content: `entry-${i}` });
    }
    widget.invalidate();

    widget.toggleExpand();
    widget.render(80);

    widget.handleInput(UP_ARROW);
    let lines = widget.render(80);
    expect(lines[1]).toContain('up arrow');

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
    const widget = new AgentLogWidget(5);
    const agents: AgentEntity[] = [];
    widget.setAgents(agents);

    // No agents in phase
    widget.setPhases(['test']);
    widget.setCurrentPhase('test');
    expect(widget.getSelectedAgentUid()).toBeNull();

    // Register an agent
    const entity = makeAgent({ agentId: 'agent-1', profile: 'coder', phase: 'test' });
    agents.push(entity);
    widget.invalidate();
    expect(widget.getSelectedAgentUid()).toBe(entity.uid);
  });

  // ─── Header shows updated stats ────────────────────────────────────────

  it('header shows updated stats after updating entity stats', () => {
    const { widget, agents, uid } = setupWidget(5);
    const agent = agents.find((a) => a.uid === uid)!;
    agent.taskTitle = 'Refactor module';
    agent.toolCallCount = 5;
    agent.inputTokens = 500;
    agent.outputTokens = 200;
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
    const widget = new AgentLogWidget(5);
    const entity = makeAgent({ agentId: 'custom-agent', profile: '', phase: 'test', uid: 'myuid' });
    widget.setAgents([entity]);
    widget.setPhases(['test']);
    widget.setCurrentPhase('test');

    const lines = widget.render(80);
    expect(lines[0]).toContain('myuid');
  });

  // ─── Multi-line entries ────────────────────────────────────────────────

  it('splits multi-line entries into separate rendered lines', () => {
    const { widget, agents, uid } = setupWidget(10);
    const agent = agents.find((a) => a.uid === uid)!;
    agent.log.push({ id: '1', timestamp: '', type: 'thinking', content: 'line1\nline2\nline3' });
    widget.invalidate();

    const lines = widget.render(WIDTH);
    expect(lines.length).toBe(10);
    expect(lines[1]).toContain('🧠');
    expect(lines[1]).toContain('line1');
    expect(lines[2]).toContain('line2');
    expect(lines[2]).not.toContain('🧠');
    expect(lines[3]).toContain('line3');
    expect(lines[3]).not.toContain('🧠');
  });

  it('continuation lines have aligned prefix with no icon', () => {
    const { widget, agents, uid } = setupWidget(10);
    const agent = agents.find((a) => a.uid === uid)!;
    agent.log.push({ id: '1', timestamp: '', type: 'error', content: 'msg1\nmsg2' });
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
    expect(widget.hasPhases()).toBe(true);
  });

  it('setCurrentPhase does not duplicate phases', () => {
    const widget = new AgentLogWidget(5);
    widget.setPhases(['planning', 'execution']);
    widget.setCurrentPhase('planning');
    expect(widget.getCurrentPhase()).toBe('planning');

    widget.setCurrentPhase('planning');
    expect(widget.getCurrentPhase()).toBe('planning');
    widget.setCurrentPhase('planning');
    expect(widget.getCurrentPhase()).toBe('planning');
  });

  it('setPhases clamps currentPhaseIndex when shrinking phases', () => {
    const widget = new AgentLogWidget(5);
    widget.setPhases(['a', 'b', 'c']);
    widget.setCurrentPhase('c');
    expect(widget.getCurrentPhase()).toBe('c');

    widget.setPhases(['a', 'b']);
    expect(widget.getCurrentPhase()).toBe('b');

    widget.setPhases([]);
    expect(widget.getCurrentPhase()).toBeNull();
  });

  // ─── Toggle expand resets scroll ────────────────────────────────────────

  it('toggleExpand resets scrollOffset to 0', () => {
    const { widget, agents, uid } = setupWidget(10);
    const agent = agents.find((a) => a.uid === uid)!;
    for (let i = 0; i < 45; i++) {
      agent.log.push({ id: `${i}`, timestamp: '', type: 'text', content: `entry-${i}` });
    }
    widget.invalidate();

    widget.toggleExpand();
    widget.render(80);

    widget.handleInput(UP_ARROW);
    widget.render(80);

    widget.toggleExpand();
    expect(widget.isExpanded()).toBe(false);

    widget.toggleExpand();
    const lines = widget.render(80);
    expect(lines[1]).not.toContain('up arrow');
  });

  // ─── Bug2: N/M agent indicator ───────────────────────────────────────

  describe('Bug2: N/M agent indicator', () => {
    it('header shows [1/3] when 3 agents in phase', () => {
      const widget = new AgentLogWidget(5);
      const a1 = makeAgent({ agentId: 'a1', profile: 'coder', phase: 'test' });
      const a2 = makeAgent({ agentId: 'a2', profile: 'scout', phase: 'test' });
      const a3 = makeAgent({ agentId: 'a3', profile: 'planner', phase: 'test' });

      widget.setAgents([a1, a2, a3]);
      widget.setPhases(['test']);
      widget.setCurrentPhase('test');

      const lines = widget.render(80);
      expect(lines[0]).toContain('[1/3]');
    });

    it('header shows [2/3] after right arrow', () => {
      const widget = new AgentLogWidget(5);
      const a1 = makeAgent({ agentId: 'a1', profile: 'coder', phase: 'test' });
      const a2 = makeAgent({ agentId: 'a2', profile: 'scout', phase: 'test' });
      const a3 = makeAgent({ agentId: 'a3', profile: 'planner', phase: 'test' });

      widget.setAgents([a1, a2, a3]);
      widget.setPhases(['test']);
      widget.setCurrentPhase('test');

      widget.handleInput(RIGHT_ARROW);
      const lines = widget.render(80);
      expect(lines[0]).toContain('[2/3]');
    });

    it('header shows [3/3] at last agent after wrapping', () => {
      const widget = new AgentLogWidget(5);
      const a1 = makeAgent({ agentId: 'a1', profile: 'coder', phase: 'test' });
      const a2 = makeAgent({ agentId: 'a2', profile: 'scout', phase: 'test' });
      const a3 = makeAgent({ agentId: 'a3', profile: 'planner', phase: 'test' });

      widget.setAgents([a1, a2, a3]);
      widget.setPhases(['test']);
      widget.setCurrentPhase('test');

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
      expect(lines[0]).not.toMatch(/\[\d+\/\d+]/);
    });

    it('header shows NO N/M indicator with no agents', () => {
      const widget = new AgentLogWidget(5);
      widget.setAgents([]);
      widget.setPhases(['test']);
      widget.setCurrentPhase('test');

      const lines = widget.render(80);
      expect(lines[0]).not.toMatch(/\[\d+\/\d+]/);
    });
  });

  // ─── Bug5: auto-switch on agent completion ─────────────────────────────

  describe('Bug5: auto-switch on agent completion', () => {
    it('auto-switches to active agent when selected completes', () => {
      const widget = new AgentLogWidget(5);
      const uid1 = 'a1-1';
      const uid2 = 'a2-1';
      const a1 = makeAgent({ agentId: 'a1', profile: 'coder', phase: 'test', uid: uid1 });
      const a2 = makeAgent({ agentId: 'a2', profile: 'scout', phase: 'test', uid: uid2 });
      widget.setAgents([a1, a2]);

      widget.setPhases(['test']);
      widget.setCurrentPhase('test');

      expect(widget.getSelectedAgentUid()).toBe(uid1);

      // Complete the selected agent
      a1.active = false;
      widget.invalidate();

      widget.render(80);
      expect(widget.getSelectedAgentUid()).toBe(uid2);
    });

    it('stays on completed agent when no active agents exist', () => {
      const widget = new AgentLogWidget(5);
      const uid1 = 'a1-1';
      const a1 = makeAgent({ agentId: 'a1', profile: 'coder', phase: 'test', uid: uid1 });
      widget.setAgents([a1]);

      widget.setPhases(['test']);
      widget.setCurrentPhase('test');

      expect(widget.getSelectedAgentUid()).toBe(uid1);

      a1.active = false;
      widget.invalidate();

      widget.render(80);
      expect(widget.getSelectedAgentUid()).toBe(uid1);
    });

    it('user can navigate to a completed agent and it sticks', () => {
      const widget = new AgentLogWidget(5);
      const uid1 = 'a1-1';
      const uid2 = 'a2-1';
      const a1 = makeAgent({ agentId: 'a1', profile: 'coder', phase: 'test', uid: uid1 });
      const a2 = makeAgent({ agentId: 'a2', profile: 'scout', phase: 'test', uid: uid2 });
      widget.setAgents([a1, a2]);

      widget.setPhases(['test']);
      widget.setCurrentPhase('test');

      // Complete agent-1 -> auto-switch to agent-2
      a1.active = false;
      widget.invalidate();
      widget.render(80);
      expect(widget.getSelectedAgentUid()).toBe(uid2);

      // User presses LEFT to navigate to agent-1 (completed)
      widget.handleInput(LEFT_ARROW);
      expect(widget.getSelectedAgentUid()).toBe(uid1);

      widget.render(80);
      expect(widget.getSelectedAgentUid()).toBe(uid1);
    });

    it('auto-switch resumes after phase change', () => {
      const widget = new AgentLogWidget(5);
      const uid1 = 'a1-1';
      const uid2 = 'a2-1';
      const uid3 = 'b1-1';
      const a1 = makeAgent({ agentId: 'a1', profile: 'coder', phase: 'phase-a', uid: uid1 });
      const a2 = makeAgent({ agentId: 'a2', profile: 'scout', phase: 'phase-a', uid: uid2 });
      const b1 = makeAgent({ agentId: 'b1', profile: 'planner', phase: 'phase-b', uid: uid3 });
      widget.setAgents([a1, a2, b1]);

      widget.setPhases(['phase-a', 'phase-b']);
      widget.setCurrentPhase('phase-a');

      // Complete agent-1 -> auto-switch to agent-2
      a1.active = false;
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
      expect(widget.getSelectedAgentUid()).toBe(uid2);
    });

    it('auto-switch resets after toggleExpand', () => {
      const widget = new AgentLogWidget(5);
      const uid1 = 'a1-1';
      const uid2 = 'a2-1';
      const a1 = makeAgent({ agentId: 'a1', profile: 'coder', phase: 'test', uid: uid1 });
      const a2 = makeAgent({ agentId: 'a2', profile: 'scout', phase: 'test', uid: uid2 });
      widget.setAgents([a1, a2]);

      widget.setPhases(['test']);
      widget.setCurrentPhase('test');

      // Complete agent-1 -> auto-switch to agent-2
      a1.active = false;
      widget.invalidate();
      widget.render(80);
      expect(widget.getSelectedAgentUid()).toBe(uid2);

      // Navigate to agent-1
      widget.handleInput(LEFT_ARROW);
      expect(widget.getSelectedAgentUid()).toBe(uid1);

      // Toggle expand resets _userNavigated
      widget.toggleExpand();

      // Auto-switch should fire again
      widget.render(80);
      expect(widget.getSelectedAgentUid()).toBe(uid2);
    });
  });

  // ─── Bug3 render fixes ──────────────────────────────────────────────

  describe('Bug3 render fixes', () => {
    it('render line count is always exactly getExpandedLineCount() collapsed with overflow', () => {
      const { widget, agents, uid } = setupWidget(5);
      const agent = agents.find((a) => a.uid === uid)!;
      for (let i = 0; i < 20; i++) {
        agent.log.push({ id: `${i}`, timestamp: '', type: 'text', content: `entry-${i}` });
      }
      widget.invalidate();
      expect(widget.render(WIDTH).length).toBe(5);
    });

    it('render line count is always exactly getExpandedLineCount() expanded with overflow', () => {
      const widget = new AgentLogWidget();
      const entity = makeAgent({ agentId: 'a', profile: 'p', phase: 'test' });
      for (let i = 0; i < 100; i++) {
        entity.log.push({ id: `${i}`, timestamp: '', type: 'text', content: `entry-${i}` });
      }
      widget.setAgents([entity]);
      widget.setPhases(['test']);
      widget.setCurrentPhase('test');
      widget.toggleExpand();
      widget.invalidate();
      expect(widget.render(WIDTH).length).toBe(40);
    });

    it('render line count is exact with multi-line entries causing overflow', () => {
      const { widget, agents, uid } = setupWidget(5);
      const agent = agents.find((a) => a.uid === uid)!;
      agent.log.push({ id: '1', timestamp: '', type: 'error', content: 'err1\nerr2\nerr3' });
      for (let i = 0; i < 5; i++) {
        agent.log.push({ id: `${i + 2}`, timestamp: '', type: 'text', content: `t-${i}` });
      }
      widget.invalidate();
      expect(widget.render(WIDTH).length).toBe(5);
    });

    it('no entry loses its icon line when overflow', () => {
      const { widget, agents, uid } = setupWidget(5);
      const agent = agents.find((a) => a.uid === uid)!;
      for (let i = 0; i < 20; i++) {
        agent.log.push({ id: `${i}`, timestamp: '', type: 'text', content: `entry-${i}` });
      }
      widget.invalidate();

      const lines = widget.render(WIDTH);
      expect(lines.length).toBe(5);
      expect(lines[1]).toContain('entry-16');
      expect(lines[2]).toContain('entry-17');
      expect(lines[3]).toContain('entry-18');
      expect(lines[4]).toContain('entry-19');
      for (let i = 1; i < 5; i++) {
        expect(lines[i]).toContain('💬');
      }
    });

    it('scroll indicator is a dedicated slot, not a content line', () => {
      const widget = new AgentLogWidget();
      const entity = makeAgent({ agentId: 'a1', profile: 'coder', phase: 'test' });
      for (let i = 0; i < 50; i++) {
        entity.log.push({ id: `${i}`, timestamp: '', type: 'text', content: `entry-${i}` });
      }
      widget.setAgents([entity]);
      widget.setPhases(['test']);
      widget.setCurrentPhase('test');

      widget.toggleExpand();
      widget.render(80);

      for (let i = 0; i < 5; i++) widget.handleInput(UP_ARROW);

      const lines = widget.render(80);
      expect(lines.length).toBe(40);
      expect(lines[1]).toContain('up arrow');
      expect(lines[1]).toContain('5');
      expect(lines[2]).toContain('💬');
      expect(lines[39]).toContain('💬');
    });

    it('scroll indicator absent when not scrolled — full content slots used', () => {
      const widget = new AgentLogWidget();
      const entity = makeAgent({ agentId: 'a1', profile: 'coder', phase: 'test' });
      for (let i = 0; i < 50; i++) {
        entity.log.push({ id: `${i}`, timestamp: '', type: 'text', content: `entry-${i}` });
      }
      widget.setAgents([entity]);
      widget.setPhases(['test']);
      widget.setCurrentPhase('test');
      widget.toggleExpand();

      const lines = widget.render(80);
      expect(lines.length).toBe(40);
      expect(lines[1]).not.toContain('up arrow');
      for (let i = 1; i <= 39; i++) {
        expect(lines[i]).toContain('💬');
      }
    });

    it('scrollOffset consistent: pressing up N times then render shows N (no snap/jump)', () => {
      const widget = new AgentLogWidget();
      const entity = makeAgent({ agentId: 'a1', profile: 'coder', phase: 'test' });
      for (let i = 0; i < 50; i++) {
        entity.log.push({ id: `${i}`, timestamp: '', type: 'text', content: `entry-${i}` });
      }
      widget.setAgents([entity]);
      widget.setPhases(['test']);
      widget.setCurrentPhase('test');
      widget.toggleExpand();
      widget.render(80);

      for (let i = 0; i < 5; i++) widget.handleInput(UP_ARROW);
      let lines = widget.render(80);
      expect(lines[1]).toContain('5');

      for (let i = 0; i < 5; i++) widget.handleInput(UP_ARROW);
      lines = widget.render(80);
      expect(lines[1]).toContain('10');

      for (let i = 0; i < 3; i++) widget.handleInput(DOWN_ARROW);
      lines = widget.render(80);
      expect(lines[1]).toContain('7');
    });

    it('addEntry then invalidate then render shows new entry', () => {
      const { widget, agents, uid } = setupWidget(5);
      const agent = agents.find((a) => a.uid === uid)!;

      agent.log.push({ id: '1', timestamp: '', type: 'text', content: 'first entry' });
      widget.invalidate();

      let lines = widget.render(WIDTH);
      expect(lines[1]).toContain('first entry');

      agent.log.push({ id: '2', timestamp: '', type: 'text', content: 'second entry' });
      widget.invalidate();

      lines = widget.render(WIDTH);
      expect(lines[1]).toContain('first entry');
      expect(lines[2]).toContain('second entry');
      expect(lines.length).toBe(5);
    });
  });

  // ─── Review fixes (H1 / M1 / EFF-1) ────────────────────────────────

  describe('Review fixes (H1 / M1 / EFF-1)', () => {
    it('header keeps N/M indicator and controls visible on a very long title', () => {
      const widget = new AgentLogWidget(5);
      const uid1 = 'a1-1';
      const a1 = makeAgent({ agentId: 'a1', profile: 'coder', phase: 'test', uid: uid1, taskTitle: 'A'.repeat(60) });
      const a2 = makeAgent({ agentId: 'a2', profile: 'scout', phase: 'test' });
      const a3 = makeAgent({ agentId: 'a3', profile: 'planner', phase: 'test' });
      widget.setAgents([a1, a2, a3]);
      widget.setPhases(['test']);
      widget.setCurrentPhase('test');

      const lines = widget.render(60);
      expect(lines.length).toBe(widget.getExpandedLineCount());
      expect(lines[0]).toContain('[1/3]');
      expect(lines[0]).toContain('space');
      expect(lines[0]).toContain('expand');
      const ellipsisIdx = lines[0].indexOf('…');
      const indicatorIdx = lines[0].indexOf('[1/3]');
      expect(ellipsisIdx).toBeGreaterThanOrEqual(0);
      expect(indicatorIdx).toBeGreaterThanOrEqual(0);
      expect(ellipsisIdx).toBeLessThan(indicatorIdx);
    });

    it('scrolling when expanded sets user-navigation (no auto-switch after scroll)', () => {
      const widget = new AgentLogWidget(5);
      const uid1 = 'a1-1';
      const a1 = makeAgent({ agentId: 'a1', profile: 'coder', phase: 'test', uid: uid1 });
      const a2 = makeAgent({ agentId: 'a2', profile: 'scout', phase: 'test' });
      widget.setAgents([a1, a2]);
      widget.setPhases(['test']);
      widget.setCurrentPhase('test');
      for (let i = 0; i < 60; i++) {
        a1.log.push({ id: `${i}`, timestamp: '', type: 'text', content: `entry-${i}` });
      }
      widget.invalidate();

      widget.toggleExpand();
      widget.render(80);

      widget.handleInput(UP_ARROW);
      widget.render(80);

      a1.active = false;
      widget.invalidate();
      widget.render(80);
      expect(widget.getSelectedAgentUid()).toBe(uid1);
    });

    it('render line count is exactly getExpandedLineCount() with many entries after EFF-1 guard', () => {
      const widget = new AgentLogWidget();
      const entity = makeAgent({ agentId: 'a', profile: 'p', phase: 'test' });
      for (let i = 0; i < 100; i++) {
        entity.log.push({ id: `${i}`, timestamp: '', type: 'text', content: `entry-${i}` });
      }
      widget.setAgents([entity]);
      widget.setPhases(['test']);
      widget.setCurrentPhase('test');
      widget.toggleExpand();
      widget.invalidate();

      const lines = widget.render(80);
      expect(lines.length).toBe(40);
      expect(lines.some((l) => l.includes('entry-99'))).toBe(true);
      expect(lines.some((l) => l.includes('entry-61'))).toBe(true);
    });
  });
});
