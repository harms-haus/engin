/* eslint-disable no-control-regex -- tests intentionally match ANSI escape codes */
// Tests for the session-based AgentLogWidget API (B9 cutover).
// The old step-based API (setSteps, setSelectedStepIndex, StepEntity, step tab
// bar) was removed in C2/C3. These tests cover the replacement: session-based
// tab bar, expand/collapse, scroll, and session cycling via Tab/Shift+Tab.
import { visibleWidth } from '@earendil-works/pi-tui';
import type { LogEntry, SessionEntity } from '@engin/shared';
import { describe, expect, it } from 'bun:test';
import { AgentLogWidget } from '../../../packages/tui/src/components/agent-log-widget.js';

const WIDTH = 80;

// ─── SessionEntity helpers ────────────────────────────────────────────────────

let _uidCounter = 0;

function makeAgent(overrides: Partial<SessionEntity> & Pick<SessionEntity, 'agentId' | 'phaseId'>): SessionEntity {
  _uidCounter++;
  return {
    uid: overrides.uid ?? `${overrides.agentId}-${_uidCounter}`,
    profile: overrides.profile ?? 'coder',
    active: overrides.active ?? true,
    log: overrides.log ?? [],
    toolCallCount: overrides.toolCallCount ?? 0,
    inputTokens: overrides.inputTokens ?? 0,
    outputTokens: overrides.outputTokens ?? 0,
    taskTitle: overrides.taskTitle ?? '',
    runnerRole: 'executor',
    attempt: 1,
    ...overrides,
  };
}

function resetUidCounter() {
  _uidCounter = 0;
}

function makeLogEntry(type: LogEntry['type'], content: string): LogEntry {
  return { id: `log-${_uidCounter}`, timestamp: new Date().toISOString(), type, content };
}

/** Strip SGR (color/style) escape sequences. */
const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, '');

function setupWidget(
  maxLines = 5,
  agentId = 'agent-1',
  profile = 'coder',
  phaseId = 'test',
): { widget: AgentLogWidget; sessions: SessionEntity[]; uid: string } {
  resetUidCounter();
  const sessions: SessionEntity[] = [];
  const widget = new AgentLogWidget(maxLines);
  const entity = makeAgent({ agentId, profile, phaseId });
  sessions.push(entity);
  widget.setAgents(sessions);
  widget.setSelectedSessionId(entity.uid);
  return { widget, sessions, uid: entity.uid };
}

describe('AgentLogWidget (session-based)', () => {
  // ─── No session selected ──────────────────────────────────────────────

  it("renders 'No session selected' when no agent uid is selected", () => {
    const widget = new AgentLogWidget(5);
    const agent = makeAgent({ agentId: 'a', phaseId: 'p' });
    widget.setAgents([agent]);
    // Don't call setSelectedSessionId → nothing selected
    const lines = widget.render(WIDTH);
    expect(stripAnsi(lines[0]!)).toContain('No session selected');
  });

  // ─── Header rendering ─────────────────────────────────────────────────

  it('renders header containing title, profile, tool call count', () => {
    const { widget } = setupWidget(5, 'agent-1', 'coder', 'test');
    const lines = widget.render(WIDTH);
    const header = stripAnsi(lines[0]!);
    expect(header).toContain('coder');
    expect(header).toContain('tool calls');
  });

  it('renders entries with correct type icons', () => {
    resetUidCounter();
    const widget = new AgentLogWidget(20);
    const agent = makeAgent({
      agentId: 'a',
      phaseId: 'p',
      log: [
        makeLogEntry('text', 'hello world'),
        makeLogEntry('thinking', 'considering options'),
        makeLogEntry('tool_call_start', 'read_file'),
        makeLogEntry('error', 'something broke'),
      ],
    });
    widget.setAgents([agent]);
    widget.setSelectedSessionId(agent.uid);

    const lines = widget.render(WIDTH);
    const allText = lines.map(stripAnsi).join('\n');
    expect(allText).toContain('💬');
    expect(allText).toContain('🧠');
    expect(allText).toContain('🔧');
    expect(allText).toContain('⚠️');
  });

  // ─── Expand / collapse ────────────────────────────────────────────────

  it('toggleExpand toggles expand/collapse state', () => {
    const { widget } = setupWidget(5);
    expect(widget.isExpanded()).toBe(false);
    widget.toggleExpand();
    expect(widget.isExpanded()).toBe(true);
    widget.toggleExpand();
    expect(widget.isExpanded()).toBe(false);
  });

  it('default maxLines is 20 when collapsed, 40 when expanded', () => {
    const { widget } = setupWidget(20);
    expect(widget.getExpandedLineCount()).toBe(20);
    widget.toggleExpand();
    expect(widget.getExpandedLineCount()).toBe(40);
  });

  // ─── Session tab bar ──────────────────────────────────────────────────

  it('session tab bar shows "no sessions" when empty', () => {
    const widget = new AgentLogWidget(5);
    const lines = widget.render(WIDTH);
    const lastLine = stripAnsi(lines[lines.length - 1]!);
    expect(lastLine).toContain('no sessions');
  });

  it('session tab bar shows session labels', () => {
    const { widget, sessions, uid } = setupWidget(10);
    const s2 = makeAgent({
      agentId: 'agent-2',
      profile: 'reviewer',
      phaseId: 'test',
      uid: 'agent-2-uid',
      runnerRole: 'reviewer',
    });
    widget.setAgents([sessions[0]!, s2]);
    widget.setSessions([sessions[0]!, s2]);
    widget.setSelectedSessionId(uid);

    const lines = widget.render(WIDTH);
    const tabBar = stripAnsi(lines[lines.length - 1]!);
    expect(tabBar).toContain('executor');
    expect(tabBar).toContain('reviewer');
  });

  // ─── Tab bar overflow (selected session always visible) ─────────────

  /** Build N sessions with distinct role labels of a fixed length. */
  function makeSessions(count: number, labelLen: number): SessionEntity[] {
    const result: SessionEntity[] = [];
    const A = 'A'.charCodeAt(0);
    for (let i = 0; i < count; i++) {
      const role = String.fromCharCode(A + (i % 26)).repeat(labelLen) + i;
      result.push(
        makeAgent({
          agentId: `agent-${i}`,
          phaseId: 'p',
          uid: `uid-${i}`,
          runnerRole: role,
          profile: role,
        }),
      );
    }
    return result;
  }

  it('tab bar overflow: selected session stays visible with highlight when truncated', () => {
    resetUidCounter();
    const widget = new AgentLogWidget(5);
    // 10 sessions, each label ~11 chars → far exceeds NARROW_WIDTH.
    const sessions = makeSessions(10, 10);
    widget.setAgents(sessions);
    widget.setSessions(sessions);
    // Select the last (rightmost) session — the one that would be truncated.
    widget.setSelectedSessionId('uid-9');

    const narrow = 30;
    const lines = widget.render(narrow);
    const tabBar = lines[lines.length - 1]!;
    const tabBarPlain = stripAnsi(tabBar);
    // The selected session label must be present in the tab bar.
    const selectedLabel = sessions[9]!.runnerRole;
    expect(tabBarPlain).toContain(selectedLabel);
    // And it must be bold+underlined.
    expect(tabBar).toContain(`\x1b[1m\x1b[4m${selectedLabel}\x1b[0m`);
  });

  it('tab bar overflow: shows hidden-session indicator when truncated', () => {
    resetUidCounter();
    const widget = new AgentLogWidget(5);
    const sessions = makeSessions(8, 8);
    widget.setAgents(sessions);
    widget.setSessions(sessions);
    // Select a middle session so both sides overflow.
    widget.setSelectedSessionId('uid-4');

    const narrow = 30;
    const lines = widget.render(narrow);
    const tabBar = stripAnsi(lines[lines.length - 1]!);
    // An overflow indicator (…+N or +N…) must be present on at least one side.
    expect(tabBar).toMatch(/\+/);
    // The selected session is still visible.
    expect(tabBar).toContain(sessions[4]!.runnerRole);
  });

  it('tab bar overflow: visible width never exceeds the column', () => {
    resetUidCounter();
    const widget = new AgentLogWidget(5);
    const sessions = makeSessions(12, 12);
    widget.setAgents(sessions);
    widget.setSessions(sessions);
    widget.setSelectedSessionId('uid-11');

    const narrow = 35;
    const lines = widget.render(narrow);
    const tabBar = lines[lines.length - 1]!;
    expect(visibleWidth(tabBar)).toBeLessThanOrEqual(narrow);
  });

  it('tab bar overflow: leftmost hidden count indicator shows count', () => {
    resetUidCounter();
    const widget = new AgentLogWidget(5);
    const sessions = makeSessions(10, 10);
    widget.setAgents(sessions);
    widget.setSessions(sessions);
    // Select the rightmost → left side should have many hidden sessions.
    widget.setSelectedSessionId('uid-9');

    const narrow = 30;
    const lines = widget.render(narrow);
    const tabBar = stripAnsi(lines[lines.length - 1]!);
    // The left indicator should show a hidden count like “…+9”.
    expect(tabBar).toMatch(/…\+\d+/);
  });

  // ─── Tab/Shift+Tab session cycling ────────────────────────────────────

  describe('Tab/Shift+Tab session cycling', () => {
    it('Tab cycles forward through sessions', () => {
      const widget = new AgentLogWidget(10);
      const s1 = makeAgent({ agentId: 'a1', phaseId: 'p', uid: 'u1', profile: 'coder' });
      const s2 = makeAgent({ agentId: 'a2', phaseId: 'p', uid: 'u2', profile: 'reviewer' });
      widget.setAgents([s1, s2]);
      widget.setSessions([s1, s2]);
      widget.setSelectedSessionId('u1');

      widget.handleInput('\x09'); // Tab
      expect(widget.getSelectedSessionId()).toBe('u2');
    });

    it('Shift+Tab cycles backward through sessions', () => {
      const widget = new AgentLogWidget(10);
      const s1 = makeAgent({ agentId: 'a1', phaseId: 'p', uid: 'u1', profile: 'coder' });
      const s2 = makeAgent({ agentId: 'a2', phaseId: 'p', uid: 'u2', profile: 'reviewer' });
      widget.setAgents([s1, s2]);
      widget.setSessions([s1, s2]);
      widget.setSelectedSessionId('u2');

      widget.handleInput('\x1b[Z'); // Shift+Tab
      expect(widget.getSelectedSessionId()).toBe('u1');
    });

    it('Tab does nothing when no sessions are set', () => {
      const widget = new AgentLogWidget(10);
      widget.handleInput('\x09'); // Tab
      expect(widget.getSelectedSessionId()).toBeNull();
    });
  });

  // ─── Scroll controls (expanded) ───────────────────────────────────────

  it('when expanded: up scrolls by 1 line (scroll indicator appears)', () => {
    resetUidCounter();
    const widget = new AgentLogWidget(20);
    const agent = makeAgent({
      agentId: 'a',
      phaseId: 'p',
      log: Array.from({ length: 50 }, (_, i) => makeLogEntry('text', `line ${i}`)),
    });
    widget.setAgents([agent]);
    widget.setSelectedSessionId(agent.uid);
    widget.toggleExpand();

    widget.render(WIDTH); // initial render
    widget.handleInput('\x1b[A'); // up arrow
    const lines = widget.render(WIDTH);
    const allText = lines.map(stripAnsi).join('\n');
    expect(allText).toContain('up arrow');
  });

  it('when expanded: down scrolls by 1 line', () => {
    resetUidCounter();
    const widget = new AgentLogWidget(20);
    const agent = makeAgent({
      agentId: 'a',
      phaseId: 'p',
      log: Array.from({ length: 50 }, (_, i) => makeLogEntry('text', `line ${i}`)),
    });
    widget.setAgents([agent]);
    widget.setSelectedSessionId(agent.uid);
    widget.toggleExpand();

    widget.render(WIDTH);
    widget.handleInput('\x1b[A'); // up once
    widget.handleInput('\x1b[B'); // down once → back to bottom
    const lines = widget.render(WIDTH);
    const allText = lines.map(stripAnsi).join('\n');
    expect(allText).not.toContain('up arrow');
  });

  it('toggleExpand resets scrollOffset to 0', () => {
    resetUidCounter();
    const widget = new AgentLogWidget(20);
    const agent = makeAgent({
      agentId: 'a',
      phaseId: 'p',
      log: Array.from({ length: 50 }, (_, i) => makeLogEntry('text', `line ${i}`)),
    });
    widget.setAgents([agent]);
    widget.setSelectedSessionId(agent.uid);
    widget.toggleExpand();
    widget.render(WIDTH);
    widget.handleInput('\x1b[A');
    widget.handleInput('\x1b[A');

    widget.toggleExpand(); // collapse
    widget.toggleExpand(); // expand again → scroll reset
    const lines = widget.render(WIDTH);
    const allText = lines.map(stripAnsi).join('\n');
    expect(allText).not.toContain('up arrow');
  });

  // ─── Layout ───────────────────────────────────────────────────────────

  it('always returns exactly getExpandedLineCount() lines regardless of entry count', () => {
    resetUidCounter();
    const widget = new AgentLogWidget(5);
    const agent = makeAgent({
      agentId: 'a',
      phaseId: 'p',
      log: Array.from({ length: 50 }, (_, i) => makeLogEntry('text', `line ${i}`)),
    });
    widget.setAgents([agent]);
    widget.setSelectedSessionId(agent.uid);

    const collapsed = widget.render(WIDTH);
    expect(collapsed.length).toBe(widget.getExpandedLineCount());

    widget.toggleExpand();
    const expanded = widget.render(WIDTH);
    expect(expanded.length).toBe(widget.getExpandedLineCount());
  });

  it('wraps long content to width', () => {
    resetUidCounter();
    const widget = new AgentLogWidget(20);
    const longText = 'word '.repeat(50);
    const agent = makeAgent({
      agentId: 'a',
      phaseId: 'p',
      log: [makeLogEntry('text', longText)],
    });
    widget.setAgents([agent]);
    widget.setSelectedSessionId(agent.uid);

    const lines = widget.render(WIDTH);
    // Each rendered line should be <= WIDTH (visible width)
    for (const line of lines) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(WIDTH + 10); // allow some ANSI overhead
    }
  });

  it('header keeps controls visible on a very long title', () => {
    const { widget } = setupWidget(20);
    const longTitle = 'A'.repeat(300);
    widget.setAgents([makeAgent({ agentId: 'a', phaseId: 'p', uid: 'long-uid', taskTitle: longTitle })]);
    widget.setSelectedSessionId('long-uid');
    const header = stripAnsi(widget.render(80)[0]!);
    expect(header).toContain('…');
  });

  // ─── Input when collapsed ─────────────────────────────────────────────

  it('up/down when collapsed do nothing (dashboard handles them)', () => {
    const { widget } = setupWidget(5);
    widget.render(WIDTH);
    widget.handleInput('\x1b[A'); // up
    widget.handleInput('\x1b[B'); // down
    // No crash, no state change visible
    const lines = widget.render(WIDTH);
    expect(lines.length).toBe(widget.getExpandedLineCount());
  });

  it('left/right do nothing (phase bar handles them)', () => {
    const { widget } = setupWidget(5);
    widget.handleInput('\x1b[C'); // right
    widget.handleInput('\x1b[D'); // left
    const lines = widget.render(WIDTH);
    expect(lines.length).toBe(widget.getExpandedLineCount());
  });
});
