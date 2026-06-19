/* eslint-disable no-control-regex -- tests intentionally match ANSI escape codes */
import type { AgentEntity, StepEntity } from '@engin/shared';
import { describe, expect, it } from 'bun:test';
import { AgentLogWidget } from '../../../packages/tui/src/components/agent-log-widget.js';

const WIDTH = 40;

// Arrow key escape sequences
const UP_ARROW = '\x1b[A';
const DOWN_ARROW = '\x1b[B';
const SHIFT_UP = '\x1b[1;2A';
const SHIFT_DOWN = '\x1b[1;2B';
const TAB_KEY = '\x09';
const SHIFT_TAB = '\x1b[Z';

// ─── AgentEntity helpers ──────────────────────────────────────────────────────

let _uidCounter = 0;

function makeAgent(overrides: Partial<AgentEntity> & Pick<AgentEntity, 'agentId' | 'phaseId'>): AgentEntity {
  _uidCounter++;
  return {
    ...overrides,
    uid: overrides.uid ?? overrides.agentId + '-' + _uidCounter,
    profile: overrides.profile ?? 'coder',
    active: overrides.active ?? true,
    log: overrides.log ?? [],
    toolCallCount: overrides.toolCallCount ?? 0,
    inputTokens: overrides.inputTokens ?? 0,
    outputTokens: overrides.outputTokens ?? 0,
    taskTitle: overrides.taskTitle ?? '',
    completedAt: overrides.completedAt,
    stepIndex: overrides.stepIndex,
    taskId: overrides.taskId,
    sessionId: overrides.sessionId,
    sessionPath: overrides.sessionPath,
  };
}

function resetUidCounter() {
  _uidCounter = 0;
}

/**
 * Helper: create a StepEntity quickly.
 */
function makeStep(overrides: Partial<StepEntity> & Pick<StepEntity, 'name' | 'index'>): StepEntity {
  return {
    ...overrides,
    profile: overrides.profile,
    agentKey: overrides.agentKey,
    isReadOnly: overrides.isReadOnly ?? false,
  };
}

/**
 * Helper: set up a widget with agents and steps, selecting a particular step.
 */
function setupWidget(
  maxLines = 5,
  agentId = 'agent-1',
  profile = 'coder',
  phaseId = 'test',
  stepName = 'step-0',
  stepIndex = 0,
  agentKey?: string,
): {
  widget: AgentLogWidget;
  agents: AgentEntity[];
  steps: StepEntity[];
  uid: string;
} {
  resetUidCounter();
  const agents: AgentEntity[] = [];
  const steps: StepEntity[] = [];
  const widget = new AgentLogWidget(maxLines);

  const entity = makeAgent({ agentId, profile, phaseId });
  agents.push(entity);
  widget.setAgents(agents);

  const key = agentKey ?? entity.uid;
  const step = makeStep({ name: stepName, index: stepIndex, agentKey: key });
  steps.push(step);
  widget.setSteps(steps);
  widget.setSelectedStepIndex(0);

  return { widget, agents, steps, uid: entity.uid };
}

describe('AgentLogWidget', () => {
  // ─── No agent selected ────────────────────────────────────────────────

  it("renders 'No agent for step' when selected step has no agentKey", () => {
    const widget = new AgentLogWidget(5);
    const steps = [makeStep({ name: 'review', index: 0 })]; // no agentKey
    widget.setSteps(steps);
    widget.setSelectedStepIndex(0);

    const lines = widget.render(WIDTH);
    expect(lines.length).toBe(5);
    expect(lines[0]).toContain('No agent for step');
    expect(lines[0]).toContain('review');
    // Last line is the tab bar
    expect(lines[4]).toContain('review');
  });

  it("renders 'No agent for step' with unknown step name when selectedStepIndex is out of range", () => {
    const widget = new AgentLogWidget(5);
    // No steps set at all
    const lines = widget.render(WIDTH);
    expect(lines[0]).toContain('No agent for step');
    expect(lines[0]).toContain('unknown');
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
    expect(lines[0]).toContain('Tab step space expand');
    // Controls should be at the end of the line
    const header = lines[0];
    const stripped = header.replace(/\x1b\[[^a-zA-Z]*[a-zA-Z]/g, '');
    expect(stripped.endsWith('space expand') || stripped.endsWith('space expand ')).toBe(true);
  });

  it('renders controls text right-aligned in header when expanded', () => {
    const { widget } = setupWidget(5);
    widget.toggleExpand();
    const lines = widget.render(80);
    expect(lines[0]).toContain('↑↓scroll x10⇧↑↓ space collapse');
  });

  // ─── Tab bar rendering ────────────────────────────────────────────────

  it('tab bar shows step names with positional markers when activeStepIndex=1', () => {
    const { widget, agents, uid } = setupWidget(10, 'agent-1', 'coder', 'test', 'write-tests', 0, 'agent-key-1');

    // Add more steps: one before active, one active, one after
    const steps: StepEntity[] = [
      makeStep({ name: 'plan', index: 0, agentKey: 'agent-key-0' }),
      makeStep({ name: 'write-tests', index: 1, agentKey: uid }),
      makeStep({ name: 'review', index: 2, agentKey: 'agent-key-2' }),
    ];
    // Add the extra agents
    const extra1 = makeAgent({ agentId: 'extra-0', profile: 'planner', phaseId: 'test', uid: 'agent-key-0' });
    const extra2 = makeAgent({ agentId: 'extra-2', profile: 'reviewer', phaseId: 'test', uid: 'agent-key-2' });
    agents.push(extra1, extra2);
    widget.setAgents(agents);
    widget.setSteps(steps);
    widget.setSelectedStepIndex(1);
    widget.setActiveStepIndex(1); // write-tests is active

    const lines = widget.render(80);
    const lastLine = lines[lines.length - 1];

    // step 0 (plan) is done (index < activeStepIndex=1) → ✓
    expect(lastLine).toContain('1 plan ✓');
    // step 1 (write-tests) is active → ▶, and selected (bold/underlined)
    expect(lastLine).toContain('2 write-tests ▶');
    // step 2 (review) is pending → ○
    expect(lastLine).toContain('3 review ○');
  });

  it('tab bar shows done/active/pending markers correctly when activeStepIndex=0', () => {
    const { widget, agents } = setupWidget(10, 'agent-1', 'coder', 'test', 'active-step', 0);

    const steps: StepEntity[] = [
      makeStep({ name: 'active-step', index: 0, agentKey: 'agent-key-0' }),
      makeStep({ name: 'pending-step', index: 1, agentKey: 'agent-key-1' }),
      makeStep({ name: 'pending-step-2', index: 2, agentKey: 'agent-key-2' }),
    ];
    const extra1 = makeAgent({ agentId: 'e1', profile: 'p1', phaseId: 'test', uid: 'agent-key-1' });
    const extra2 = makeAgent({ agentId: 'e2', profile: 'p2', phaseId: 'test', uid: 'agent-key-2' });
    agents.push(extra1, extra2);
    widget.setAgents(agents);
    widget.setSteps(steps);
    widget.setSelectedStepIndex(0);
    widget.setActiveStepIndex(0);

    const lines = widget.render(80);
    const lastLine = lines[lines.length - 1];

    expect(lastLine).toContain('1 active-step ▶');
    expect(lastLine).toContain('2 pending-step ○');
    expect(lastLine).toContain('3 pending-step-2 ○');
  });

  it('tab bar shows all done markers when activeStepIndex is past last step', () => {
    const { widget, agents } = setupWidget(10, 'agent-1', 'coder', 'test', 'step0', 0);

    const steps: StepEntity[] = [
      makeStep({ name: 'step0', index: 0, agentKey: 'agent-key-0' }),
      makeStep({ name: 'step1', index: 1, agentKey: 'agent-key-1' }),
    ];
    const extra1 = makeAgent({ agentId: 'e1', profile: 'p1', phaseId: 'test', uid: 'agent-key-1' });
    agents.push(extra1);
    widget.setAgents(agents);
    widget.setSteps(steps);
    widget.setSelectedStepIndex(0);
    widget.setActiveStepIndex(5); // past last step

    const lines = widget.render(80);
    const lastLine = lines[lines.length - 1];

    expect(lastLine).toContain('1 step0 ✓');
    expect(lastLine).toContain('2 step1 ✓');
  });

  it('tab bar dims steps without agentKey', () => {
    const { widget, agents, uid } = setupWidget(10, 'agent-1', 'coder', 'test', 'with-agent', 0, 'agent-key-0');

    const steps: StepEntity[] = [
      makeStep({ name: 'with-agent', index: 0, agentKey: uid }),
      makeStep({ name: 'no-agent', index: 1 }), // no agentKey — should be dimmed
    ];
    widget.setAgents(agents);
    widget.setSteps(steps);
    widget.setSelectedStepIndex(0);
    widget.setActiveStepIndex(0);

    const lines = widget.render(80);
    const lastLine = lines[lines.length - 1];

    // The no-agent step should have ANSI dim codes
    expect(lastLine).toContain('no-agent');
    // Check it is wrapped in dim escape codes (the whole label should be dimmed)
    // We need to check that the step name appears between a dim sequence
    const dimmedPart = lastLine.match(/\x1b\[2m(.*?)\x1b\[0m/);
    expect(dimmedPart).not.toBeNull();
    expect(dimmedPart![1]).toContain('no-agent');
  });

  it('tab bar underlines/bolds the selected step', () => {
    const { widget, agents, uid } = setupWidget(10, 'agent-1', 'coder', 'test', 'step-a', 0, 'agent-key-0');

    const steps: StepEntity[] = [
      makeStep({ name: 'step-a', index: 0, agentKey: uid }),
      makeStep({ name: 'step-b', index: 1, agentKey: 'agent-key-1' }),
    ];
    const extra1 = makeAgent({ agentId: 'e1', profile: 'p1', phaseId: 'test', uid: 'agent-key-1' });
    agents.push(extra1);
    widget.setAgents(agents);
    widget.setSteps(steps);
    widget.setSelectedStepIndex(0);
    widget.setActiveStepIndex(0);

    const lines = widget.render(80);
    const lastLine = lines[lines.length - 1];

    // step-a is selected; check for bold + underline codes
    expect(lastLine).toContain('\x1b[1m'); // bold
    expect(lastLine).toContain('\x1b[4m'); // underline
    expect(lastLine).toContain('step-a');

    // step-b should NOT have bold/underline
    const bIndex = lastLine.indexOf('step-b');
    const beforeB = lastLine.slice(0, bIndex);
    // The last escape before step-b should be [0m (reset), not [1m or [4m
    const lastEscape = beforeB.match(/\x1b\[([\d;]*)m/g);
    if (lastEscape && lastEscape.length > 0) {
      const finalEsc = lastEscape[lastEscape.length - 1];
      // It should be reset [0m, not bold [1m or underline [4m
      expect(finalEsc).toBe('\x1b[0m');
    }
  });

  it('tab bar shows "no steps" when steps array is empty', () => {
    const widget = new AgentLogWidget(5);
    const lines = widget.render(WIDTH);
    const lastLine = lines[lines.length - 1];
    expect(lastLine).toContain('no steps');
  });

  // ─── Entry rendering ────────────────────────────────────────────────────

  it('renders entries with correct type icons', () => {
    // Use 6 lines so entrySlots=4 and all 4 entries are visible
    const { widget, agents, uid } = setupWidget(6);
    const agent = agents.find((a) => a.uid === uid)!;
    agent.log.push({ id: '1', timestamp: '', type: 'text', content: 'hello' });
    agent.log.push({ id: '2', timestamp: '', type: 'thinking', content: 'pondering' });
    agent.log.push({ id: '3', timestamp: '', type: 'error', content: 'oops' });
    agent.log.push({ id: '4', timestamp: '', type: 'tool_call_start', content: 'running tool' });
    widget.invalidate();

    const lines = widget.render(WIDTH);
    // lines[0] = header, lines[1-4] = entries (totalLines=6, line[5]=tab bar)
    expect(lines[1]).toContain('💬');
    expect(lines[2]).toContain('🧠');
    expect(lines[3]).toContain('⚠️');
    // tool_call_start is formatted by formatToolCall which emits its own emoji
    expect(lines[4]).toContain('running tool');
  });

  // ─── render entry type (typeIconMap / typeColorMap) ────────────────────
  //
  // After T1, LogEntry['type'] includes 'render'. Both `typeIconMap` and
  // `typeColorMap` are typed as Record<LogEntry['type'], ...>, so each must
  // provide an entry for 'render'. The maps are module-private, so the
  // contract is observed through render() output:
  //   - typeIconMap['render']  → '📋' (clipboard emoji, U+1F4CB)
  //   - typeColorMap['render'] → null  (no colour transform; content as-is,
  //                                     identical to 'text' and 'decision')
  //   - render entries are NOT filtered out (the loop skips only tool_call_end)
  //   - render content is shown verbatim (NOT run through formatToolCall,
  //     unlike 'tool_call' / 'tool_call_start')
  describe('render entry type (typeIconMap / typeColorMap)', () => {
    it('renders a render-type entry with the clipboard icon (U+1F4CB)', () => {
      const { widget, agents, uid } = setupWidget(6);
      const agent = agents.find((a) => a.uid === uid)!;
      agent.log.push({ id: '1', timestamp: '', type: 'render', content: 'rendered-artifact' });
      widget.invalidate();

      const lines = widget.render(WIDTH);
      // lines[0]=header, lines[1]=first entry slot, lines[5]=tab bar
      expect(lines[1]).toContain('📋');
      expect(lines[1]).toContain('rendered-artifact');
    });

    it('does not fall back to the literal "undefined" for the render icon', () => {
      // Guards against a missing typeIconMap['render'] entry (the pre-fix
      // bug): an absent key would interpolate `undefined` into the prefix,
      // producing a line like "  undefined xyz-content".
      const { widget, agents, uid } = setupWidget(6);
      const agent = agents.find((a) => a.uid === uid)!;
      agent.log.push({ id: '1', timestamp: '', type: 'render', content: 'xyz-content' });
      widget.invalidate();

      const lines = widget.render(WIDTH);
      expect(lines[1]).toContain('xyz-content');
      expect(lines[1]).not.toContain('undefined');
    });

    it('does not filter out render entries (only tool_call_end is skipped)', () => {
      const { widget, agents, uid } = setupWidget(6);
      const agent = agents.find((a) => a.uid === uid)!;
      agent.log.push({ id: '1', timestamp: '', type: 'tool_call_end', content: 'END_HIDDEN_MARKER' });
      agent.log.push({ id: '2', timestamp: '', type: 'render', content: 'RENDER_VISIBLE_MARKER' });
      widget.invalidate();

      const joined = widget.render(WIDTH).join('\n');
      expect(joined).toContain('RENDER_VISIBLE_MARKER');
      expect(joined).not.toContain('END_HIDDEN_MARKER');
    });

    it('applies no ANSI colour wrapping to render entries (typeColorMap null)', () => {
      const { widget, agents, uid } = setupWidget(6);
      const agent = agents.find((a) => a.uid === uid)!;
      agent.log.push({ id: '1', timestamp: '', type: 'render', content: 'plain render text' });
      widget.invalidate();

      const lines = widget.render(WIDTH);
      // colorFn is null → raw prefix+text emitted with no escape codes
      expect(lines[1]).not.toMatch(/\x1b\[/);
    });

    it('shows render content verbatim (not run through formatToolCall)', () => {
      // tool_call / tool_call_start entries are formatted; a render entry must
      // display its content unchanged. Render at a wide width so the long
      // content is not wrapped/split across lines.
      const { widget, agents, uid } = setupWidget(6);
      const agent = agents.find((a) => a.uid === uid)!;
      agent.log.push({
        id: '1',
        timestamp: '',
        type: 'render',
        content: 'writeFile({ path: "/tmp/x", force: true })',
      });
      widget.invalidate();

      const lines = widget.render(120);
      expect(lines[1]).toContain('writeFile({ path: "/tmp/x", force: true })');
    });
  });

  it('wraps long content to width', () => {
    const { widget, agents, uid } = setupWidget(6);
    const agent = agents.find((a) => a.uid === uid)!;
    agent.log.push({ id: '1', timestamp: '', type: 'text', content: 'This is a very long string that should wrap' });
    widget.invalidate();

    // width=20, prefix '  💬 ' has visibleWidth=5, remainingWidth=15
    // The wrapped lines are: 'This is a very' (14), 'long string' (11), 'that should' (11), 'wrap' (4)
    // With 6 total lines: header(0) + entrySlots(4) + tabBar(5), all 4 fit
    const lines = widget.render(20);
    expect(lines.length).toBe(6);
    const entryContent = lines.slice(1, 5).join(''); // skip header and tab bar
    expect(entryContent).not.toContain('…');
    const entryLines = lines.slice(1, 5).filter((l) => l.trim().length > 0);
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
    const r1: AgentEntity[] = [makeAgent({ agentId: 'a', profile: 'p', phaseId: 'test' })];
    const s1: StepEntity[] = [makeStep({ name: 'step0', index: 0, agentKey: r1[0].uid })];
    w1.setAgents(r1);
    w1.setSteps(s1);
    w1.setSelectedStepIndex(0);
    expect(w1.render(WIDTH).length).toBe(3);

    // Test with 1 entry
    const w2 = new AgentLogWidget(3);
    const u2e = makeAgent({ agentId: 'a', profile: 'p', phaseId: 'test' });
    u2e.log.push({ id: '1', timestamp: '', type: 'text', content: 'hi' });
    const s2: StepEntity[] = [makeStep({ name: 'step0', index: 0, agentKey: u2e.uid })];
    w2.setAgents([u2e]);
    w2.setSteps(s2);
    w2.setSelectedStepIndex(0);
    expect(w2.render(WIDTH).length).toBe(3);

    // Test with more entries than slots
    const w4 = new AgentLogWidget(3);
    const u4e = makeAgent({ agentId: 'a', profile: 'p', phaseId: 'test' });
    for (const c of ['a', 'b', 'c', 'd']) {
      u4e.log.push({ id: '1', timestamp: '', type: 'text', content: c });
    }
    const s4: StepEntity[] = [makeStep({ name: 'step0', index: 0, agentKey: u4e.uid })];
    w4.setAgents([u4e]);
    w4.setSteps(s4);
    w4.setSelectedStepIndex(0);
    const lines = w4.render(WIDTH);
    expect(lines.length).toBe(3);
    // header + 1 entry slot (totalLines=3, that leaves 1 for entry and 1 for tab bar)
    // entrySlots = totalLines - 2 = 1
    // So we expect only 1 entry visible, the most recent one
    expect(lines[1]).toContain('d');
  });

  it('default maxLines is 20 when collapsed, 40 when expanded', () => {
    const widget = new AgentLogWidget();
    const agents = [makeAgent({ agentId: 'a', profile: 'p', phaseId: 'test' })];
    const steps = [makeStep({ name: 'step0', index: 0, agentKey: agents[0].uid })];
    widget.setAgents(agents);
    widget.setSteps(steps);
    widget.setSelectedStepIndex(0);

    // Collapsed: 20 lines
    expect(widget.render(WIDTH).length).toBe(20);

    // Expanded: 40 lines
    widget.toggleExpand();
    expect(widget.render(WIDTH).length).toBe(40);
  });

  // ─── Ring buffer ────────────────────────────────────────────────────────

  it('entry ring buffer caps at 200 entries', () => {
    const widget = new AgentLogWidget(200);
    const agent = makeAgent({ agentId: 'agent-2', profile: 'coder', phaseId: 'test' });
    const steps = [makeStep({ name: 'step0', index: 0, agentKey: agent.uid })];
    widget.setAgents([agent]);
    widget.setSteps(steps);
    widget.setSelectedStepIndex(0);

    for (let i = 0; i < 201; i++) {
      agent.log.push({ id: `${i}`, timestamp: '', type: 'text', content: `entry-${i}` });
    }
    widget.invalidate();

    const lines = widget.render(80);

    // After adding 201 entries, entry-0 and entry-1 were shifted (cap at ~199 due to renderNeeded)
    // With maxLines=200, totalLines=200, entrySlots=198, renderNeeded = 198 + 0 + 1 = 199
    // After 201 pushes with shift, pending contains indices 2..200 (199 items)
    // startIdx = max(0, 199 - 198 - 0) = 1
    // So the first visible entry is pending[1] which is entry-3
    expect(lines[1]).toContain('entry-3');
    // Last entry before tab bar should be entry-200 at lines[198]
    expect(lines[198]).toContain('entry-200');
    // Header + 198 visible entries + tab bar = 200 lines total
    expect(lines.length).toBe(200);
  });

  // ─── Tab/Shift+Tab step cycling ────────────────────────────────────────

  describe('Tab/Shift+Tab step cycling', () => {
    it('Tab cycles forward through steps that have agentKey, skipping steps without', () => {
      const widget = new AgentLogWidget(5);
      const agent0 = makeAgent({ agentId: 'a0', profile: 'p0', phaseId: 'test', uid: 'key-0' });
      const agent1 = makeAgent({ agentId: 'a1', profile: 'p1', phaseId: 'test', uid: 'key-1' });
      const agents = [agent0, agent1];

      // step0 has agentKey, step1 has agentKey, step2 has NO agentKey
      const steps: StepEntity[] = [
        makeStep({ name: 'step0', index: 0, agentKey: 'key-0' }),
        makeStep({ name: 'step1', index: 1, agentKey: 'key-1' }),
        makeStep({ name: 'step2', index: 2 }), // no agentKey
      ];

      widget.setAgents(agents);
      widget.setSteps(steps);
      widget.setSelectedStepIndex(0);

      // Initial: step0 selected
      expect(widget.getSelectedAgentUid()).toBe('key-0');

      // Tab → step1 (skips step2 because it has no agentKey)
      widget.handleInput(TAB_KEY);
      expect(widget.getSelectedAgentUid()).toBe('key-1');

      // Tab → wraps back to step0 (step2 skipped)
      widget.handleInput(TAB_KEY);
      expect(widget.getSelectedAgentUid()).toBe('key-0');
    });

    it('Shift+Tab cycles backward through steps that have agentKey', () => {
      const widget = new AgentLogWidget(5);
      const agent0 = makeAgent({ agentId: 'a0', profile: 'p0', phaseId: 'test', uid: 'key-0' });
      const agent1 = makeAgent({ agentId: 'a1', profile: 'p1', phaseId: 'test', uid: 'key-1' });
      const agents = [agent0, agent1];

      const steps: StepEntity[] = [
        makeStep({ name: 'step0', index: 0, agentKey: 'key-0' }),
        makeStep({ name: 'step1', index: 1, agentKey: 'key-1' }),
        makeStep({ name: 'step2', index: 2 }), // no agentKey
      ];

      widget.setAgents(agents);
      widget.setSteps(steps);
      widget.setSelectedStepIndex(0);

      // Initial: step0
      expect(widget.getSelectedAgentUid()).toBe('key-0');

      // Shift+Tab → wraps to step1 (skips step2)
      widget.handleInput(SHIFT_TAB);
      expect(widget.getSelectedAgentUid()).toBe('key-1');

      // Shift+Tab → step0
      widget.handleInput(SHIFT_TAB);
      expect(widget.getSelectedAgentUid()).toBe('key-0');
    });

    it('Tab does nothing when no steps have agentKey', () => {
      const widget = new AgentLogWidget(5);
      const steps: StepEntity[] = [makeStep({ name: 'step0', index: 0 }), makeStep({ name: 'step1', index: 1 })];

      widget.setSteps(steps);
      widget.setSelectedStepIndex(0);

      expect(widget.getSelectedAgentUid()).toBeNull();

      widget.handleInput(TAB_KEY);
      expect(widget.getSelectedAgentUid()).toBeNull();
    });

    it('Tab does nothing when steps array is empty', () => {
      const widget = new AgentLogWidget(5);
      widget.setSteps([]);

      expect(widget.getSelectedAgentUid()).toBeNull();

      widget.handleInput(TAB_KEY);
      expect(widget.getSelectedAgentUid()).toBeNull();
    });
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

  it('when expanded: up scrolls by 1 line (scroll indicator appears)', () => {
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

  it('when expanded: down scrolls by 1 line', () => {
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

  it('when expanded: shift+up scrolls by 10 lines', () => {
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

  it('when expanded: shift+down scrolls by 10 lines', () => {
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
    expect(lines[1]).toContain('4');
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

  // ─── getSelectedAgentUid ──────────────────────────────────────────────

  it('getSelectedAgentUid() returns agentKey of selected step or null', () => {
    const widget = new AgentLogWidget(5);

    // No steps
    expect(widget.getSelectedAgentUid()).toBeNull();

    // Steps with agentKey
    const agent0 = makeAgent({ agentId: 'a0', profile: 'p0', phaseId: 'test', uid: 'key-0' });
    const steps: StepEntity[] = [
      makeStep({ name: 'step0', index: 0, agentKey: 'key-0' }),
      makeStep({ name: 'step1', index: 1, agentKey: 'key-1' }),
    ];
    widget.setAgents([agent0]);
    widget.setSteps(steps);
    widget.setSelectedStepIndex(0);
    expect(widget.getSelectedAgentUid()).toBe('key-0');

    // Step without agentKey
    widget.setSelectedStepIndex(1);
    expect(widget.getSelectedAgentUid()).toBe('key-1');

    // Index out of range
    widget.setSelectedStepIndex(-1);
    expect(widget.getSelectedAgentUid()).toBeNull();
  });

  // ─── setSelectedAgentUid ──────────────────────────────────────────────

  it('setSelectedAgentUid finds step with matching agentKey', () => {
    const widget = new AgentLogWidget(5);
    const agent0 = makeAgent({ agentId: 'a0', profile: 'p0', phaseId: 'test', uid: 'key-0' });
    const steps: StepEntity[] = [
      makeStep({ name: 'step0', index: 0, agentKey: 'key-0' }),
      makeStep({ name: 'step1', index: 1, agentKey: 'key-1' }),
    ];
    widget.setAgents([agent0]);
    widget.setSteps(steps);
    widget.setSelectedStepIndex(0);

    widget.setSelectedAgentUid('key-1');
    expect(widget.getSelectedAgentUid()).toBe('key-1');
  });

  it('setSelectedAgentUid(null) deselects (index=-1)', () => {
    const widget = new AgentLogWidget(5);
    const agent0 = makeAgent({ agentId: 'a0', profile: 'p0', phaseId: 'test', uid: 'key-0' });
    const steps: StepEntity[] = [makeStep({ name: 'step0', index: 0, agentKey: 'key-0' })];
    widget.setAgents([agent0]);
    widget.setSteps(steps);
    widget.setSelectedStepIndex(0);

    widget.setSelectedAgentUid(null);
    expect(widget.getSelectedAgentUid()).toBeNull();
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

    const lines = widget.render(120);
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
    const entity = makeAgent({ agentId: 'custom-agent', profile: '', phaseId: 'test', uid: 'myuid' });
    const steps = [makeStep({ name: 'step0', index: 0, agentKey: 'myuid' })];
    widget.setAgents([entity]);
    widget.setSteps(steps);
    widget.setSelectedStepIndex(0);

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

  // ─── Up/down when collapsed do nothing ───────────────────────────────

  it('up/down when collapsed do nothing (dashboard handles them)', () => {
    const { widget } = setupWidget(5);
    expect(widget.isExpanded()).toBe(false);

    // Up arrow when collapsed — should do nothing (no error, no phase change)
    widget.handleInput(UP_ARROW);
    // Should not crash, should still render normally
    const lines = widget.render(WIDTH);
    expect(lines.length).toBe(5);

    // Down arrow when collapsed — should do nothing
    widget.handleInput(DOWN_ARROW);
    const lines2 = widget.render(WIDTH);
    expect(lines2.length).toBe(5);
  });

  // ─── Left/right do nothing ───────────────────────────────────────────

  it('left/right do nothing (phase bar handles them)', () => {
    const { widget } = setupWidget(5);

    // Left arrow — should do nothing
    widget.handleInput('\x1b[D');
    const lines = widget.render(WIDTH);
    expect(lines.length).toBe(5);

    // Right arrow — should do nothing
    widget.handleInput('\x1b[C');
    const lines2 = widget.render(WIDTH);
    expect(lines2.length).toBe(5);
  });

  // ─── setSteps / setSelectedStepIndex edge cases ────────────────────────

  it('setSteps clamps selectedStepIndex when shrinking steps', () => {
    const widget = new AgentLogWidget(5);
    const agent0 = makeAgent({ agentId: 'a0', profile: 'p0', phaseId: 'test', uid: 'key-0' });

    const steps3: StepEntity[] = [
      makeStep({ name: 'step0', index: 0, agentKey: 'key-0' }),
      makeStep({ name: 'step1', index: 1, agentKey: 'key-1' }),
      makeStep({ name: 'step2', index: 2, agentKey: 'key-2' }),
    ];
    widget.setAgents([agent0]);
    widget.setSteps(steps3);
    widget.setSelectedStepIndex(2);
    expect(widget.getSelectedAgentUid()).toBe('key-2');

    // Shrink to 2 steps — selectedStepIndex clamped to 1
    const steps2: StepEntity[] = [
      makeStep({ name: 'step0', index: 0, agentKey: 'key-0' }),
      makeStep({ name: 'step1', index: 1, agentKey: 'key-1' }),
    ];
    widget.setSteps(steps2);
    expect(widget.getSelectedAgentUid()).toBe('key-1');
  });

  it('setSelectedStepIndex ignores out-of-range indices', () => {
    const widget = new AgentLogWidget(5);
    const agent0 = makeAgent({ agentId: 'a0', profile: 'p0', phaseId: 'test', uid: 'key-0' });
    const steps: StepEntity[] = [makeStep({ name: 'step0', index: 0, agentKey: 'key-0' })];
    widget.setAgents([agent0]);
    widget.setSteps(steps);
    widget.setSelectedStepIndex(0);
    expect(widget.getSelectedAgentUid()).toBe('key-0');

    // Out of range — ignored
    widget.setSelectedStepIndex(5);
    expect(widget.getSelectedAgentUid()).toBe('key-0');

    // Negative — ignored
    widget.setSelectedStepIndex(-5);
    expect(widget.getSelectedAgentUid()).toBe('key-0');
  });

  // ─── Dead _userPinnedStep removal: regression tests ───────────────
  //
  // The private _userPinnedStep field was never read inside AgentLogWidget;
  // only written.  These tests verify that the public API methods that
  // previously assigned to _userPinnedStep still behave correctly after the
  // field is removed.
  describe('dead _userPinnedStep removal (regression)', () => {
    it('setSelectedStepIndex selects the step and resets scrollOffset', () => {
      const widget = new AgentLogWidget(10);
      const agent = makeAgent({ agentId: 'a0', profile: 'p0', phaseId: 'test', uid: 'key-0' });
      const steps: StepEntity[] = [
        makeStep({ name: 'step0', index: 0, agentKey: 'key-0' }),
        makeStep({ name: 'step1', index: 1, agentKey: 'key-1' }),
      ];
      widget.setAgents([agent]);
      widget.setSteps(steps);
      widget.setSelectedStepIndex(1);
      expect(widget.getSelectedAgentUid()).toBe('key-1');

      // After scrolling up (expanded), scrollOffset > 0
      const agent0 = agent;
      agent0.log.push({ id: '1', timestamp: '', type: 'text', content: 'line' });
      for (let i = 0; i < 8; i++) {
        agent0.log.push({ id: `${i + 2}`, timestamp: '', type: 'text', content: 'padding ' + 'x'.repeat(60) });
      }
      widget.invalidate();
      widget.toggleExpand();
      widget.render(80);
      widget.handleInput('\x1b[A'); // scroll up

      // Calling setSelectedStepIndex resets scrollOffset to 0
      widget.setSelectedStepIndex(0);
      const lines = widget.render(80);
      // No scroll indicator should appear because scrollOffset was reset
      expect(lines[1]).not.toContain('up arrow');
    });

    it('setSelectedAgentUid finds step and resets scrollOffset', () => {
      const widget = new AgentLogWidget(10);
      const agent = makeAgent({ agentId: 'a0', profile: 'p0', phaseId: 'test', uid: 'key-0' });
      const steps: StepEntity[] = [
        makeStep({ name: 'step0', index: 0, agentKey: 'key-0' }),
        makeStep({ name: 'step1', index: 1, agentKey: 'key-1' }),
      ];
      widget.setAgents([agent]);
      widget.setSteps(steps);
      widget.setSelectedStepIndex(0);

      // Select by UID
      widget.setSelectedAgentUid('key-1');
      expect(widget.getSelectedAgentUid()).toBe('key-1');

      // Select by null (deselect)
      widget.setSelectedAgentUid(null);
      expect(widget.getSelectedAgentUid()).toBeNull();
    });

    it('setSelectedAgentUid does nothing when uid not found in steps', () => {
      const widget = new AgentLogWidget(5);
      const agent = makeAgent({ agentId: 'a0', profile: 'p0', phaseId: 'test', uid: 'key-0' });
      const steps: StepEntity[] = [makeStep({ name: 'step0', index: 0, agentKey: 'key-0' })];
      widget.setAgents([agent]);
      widget.setSteps(steps);
      widget.setSelectedStepIndex(0);

      // uid 'nonexistent' not in steps — current selection unchanged
      widget.setSelectedAgentUid('nonexistent');
      expect(widget.getSelectedAgentUid()).toBe('key-0');
    });

    it('toggleExpand toggles state and resets scrollOffset', () => {
      const widget = new AgentLogWidget(10);
      const agent = makeAgent({ agentId: 'a0', profile: 'p0', phaseId: 'test', uid: 'key-0' });
      const steps: StepEntity[] = [makeStep({ name: 'step0', index: 0, agentKey: 'key-0' })];
      widget.setAgents([agent]);
      widget.setSteps(steps);
      widget.setSelectedStepIndex(0);

      // Initial: collapsed, no scroll
      expect(widget.isExpanded()).toBe(false);

      widget.toggleExpand();
      expect(widget.isExpanded()).toBe(true);

      // Scroll up a bit
      for (let i = 0; i < 45; i++) {
        agent.log.push({ id: `${i}`, timestamp: '', type: 'text', content: `entry-${i}` });
      }
      widget.invalidate();
      widget.render(80);
      widget.handleInput('\x1b[A');

      // Collapse then re-expand — scrollOffset reset to 0
      widget.toggleExpand();
      expect(widget.isExpanded()).toBe(false);

      widget.toggleExpand();
      expect(widget.isExpanded()).toBe(true);
      const lines = widget.render(80);
      expect(lines[1]).not.toContain('up arrow');
    });

    it('handleInput expanded scroll does not throw when no entries exist', () => {
      const widget = new AgentLogWidget(10);
      const agent = makeAgent({ agentId: 'a0', profile: 'p0', phaseId: 'test', uid: 'key-0' });
      const steps: StepEntity[] = [makeStep({ name: 'step0', index: 0, agentKey: 'key-0' })];
      widget.setAgents([agent]);
      widget.setSteps(steps);
      widget.setSelectedStepIndex(0);

      widget.toggleExpand();
      widget.render(80);

      // No log entries — scrolling should be a no-op, not crash
      expect(() => widget.handleInput('\x1b[A')).not.toThrow();
      expect(() => widget.handleInput('\x1b[B')).not.toThrow();
    });

    it('handleInput tab cycles steps that have agentKey and resets scrollOffset', () => {
      const widget = new AgentLogWidget(10);
      const agent0 = makeAgent({ agentId: 'a0', profile: 'p0', phaseId: 'test', uid: 'key-0' });
      const steps: StepEntity[] = [
        makeStep({ name: 'step0', index: 0, agentKey: 'key-0' }),
        makeStep({ name: 'step1', index: 1, agentKey: 'key-1' }),
        makeStep({ name: 'step2', index: 2 }), // no agentKey
      ];
      widget.setAgents([agent0]);
      widget.setSteps(steps);
      widget.setSelectedStepIndex(0);

      // Scroll to simulate having scrolled
      widget.toggleExpand();
      for (let i = 0; i < 45; i++) {
        agent0.log.push({ id: `${i}`, timestamp: '', type: 'text', content: `entry-${i}` });
      }
      widget.invalidate();
      widget.render(80);
      widget.handleInput('\x1b[A');

      // Tab away and back — should reset scrollOffset
      widget.handleInput('\x09'); // tab
      expect(widget.getSelectedAgentUid()).toBe('key-1');

      widget.handleInput('\x09'); // tab again, wraps to key-0 (skips step2)
      expect(widget.getSelectedAgentUid()).toBe('key-0');

      // After tab cycling, scrollOffset was reset so no scroll indicator
      const lines = widget.render(80);
      expect(lines[1]).not.toContain('up arrow');
    });

    it('handleInput shift+tab cycles backward through agent steps', () => {
      const widget = new AgentLogWidget(5);
      const agent0 = makeAgent({ agentId: 'a0', profile: 'p0', phaseId: 'test', uid: 'key-0' });
      const steps: StepEntity[] = [
        makeStep({ name: 'step0', index: 0, agentKey: 'key-0' }),
        makeStep({ name: 'step1', index: 1, agentKey: 'key-1' }),
      ];
      widget.setAgents([agent0]);
      widget.setSteps(steps);
      widget.setSelectedStepIndex(0);

      // Shift+Tab from step0 wraps to step1
      widget.handleInput('\x1b[Z');
      expect(widget.getSelectedAgentUid()).toBe('key-1');

      // Shift+Tab from step1 wraps to step0
      widget.handleInput('\x1b[Z');
      expect(widget.getSelectedAgentUid()).toBe('key-0');
    });

    it('handleInput up/down scroll adjustments are clamped', () => {
      const widget = new AgentLogWidget(10);
      const agent = makeAgent({ agentId: 'a0', profile: 'p0', phaseId: 'test', uid: 'key-0' });
      const steps: StepEntity[] = [makeStep({ name: 'step0', index: 0, agentKey: 'key-0' })];
      widget.setAgents([agent]);
      widget.setSteps(steps);
      widget.setSelectedStepIndex(0);

      // Add entries to allow scrolling
      for (let i = 0; i < 5; i++) {
        agent.log.push({ id: `${i}`, timestamp: '', type: 'text', content: 'x'.repeat(60) });
      }
      widget.invalidate();
      widget.toggleExpand();
      widget.render(80);

      // Repeated up arrows should clamp at max scroll offset (no crash)
      for (let i = 0; i < 100; i++) {
        widget.handleInput('\x1b[A');
      }
      expect(() => widget.render(80)).not.toThrow();

      // Repeated down arrows should clamp at 0 (no crash)
      for (let i = 0; i < 100; i++) {
        widget.handleInput('\x1b[B');
      }
      const lines = widget.render(80);
      // When expanded, _expandedLineCount is 40 (not the constructor's maxLines)
      expect(lines.length).toBe(40);
      expect(lines[1]).not.toContain('up arrow');
    });

    it('handleInput shift+up/shift+down scroll adjustments are clamped', () => {
      const widget = new AgentLogWidget(10);
      const agent = makeAgent({ agentId: 'a0', profile: 'p0', phaseId: 'test', uid: 'key-0' });
      const steps: StepEntity[] = [makeStep({ name: 'step0', index: 0, agentKey: 'key-0' })];
      widget.setAgents([agent]);
      widget.setSteps(steps);
      widget.setSelectedStepIndex(0);

      for (let i = 0; i < 50; i++) {
        agent.log.push({ id: `${i}`, timestamp: '', type: 'text', content: 'x'.repeat(60) });
      }
      widget.invalidate();
      widget.toggleExpand();
      widget.render(80);

      // Repeated shift+up arrows should clamp (no crash)
      for (let i = 0; i < 100; i++) {
        widget.handleInput('\x1b[1;2A');
      }
      expect(() => widget.render(80)).not.toThrow();

      // Repeated shift+down arrows should clamp at 0 (no crash)
      for (let i = 0; i < 100; i++) {
        widget.handleInput('\x1b[1;2B');
      }
      const lines = widget.render(80);
      expect(lines.length).toBe(40);
    });

    it('setSelectedStepIndex(-1) selects no step', () => {
      const widget = new AgentLogWidget(5);
      const agent = makeAgent({ agentId: 'a0', profile: 'p0', phaseId: 'test', uid: 'key-0' });
      const steps: StepEntity[] = [makeStep({ name: 'step0', index: 0, agentKey: 'key-0' })];
      widget.setAgents([agent]);
      widget.setSteps(steps);
      widget.setSelectedStepIndex(-1);

      expect(widget.getSelectedAgentUid()).toBeNull();
    });

    it('setSelectedStepIndex with index >= steps.length is no-op', () => {
      const widget = new AgentLogWidget(5);
      const agent = makeAgent({ agentId: 'a0', profile: 'p0', phaseId: 'test', uid: 'key-0' });
      const steps: StepEntity[] = [makeStep({ name: 'step0', index: 0, agentKey: 'key-0' })];
      widget.setAgents([agent]);
      widget.setSteps(steps);
      widget.setSelectedStepIndex(0);
      expect(widget.getSelectedAgentUid()).toBe('key-0');

      // index >= steps.length (1) → no-op
      widget.setSelectedStepIndex(100);
      expect(widget.getSelectedAgentUid()).toBe('key-0');
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
      const entity = makeAgent({ agentId: 'a', profile: 'p', phaseId: 'test' });
      for (let i = 0; i < 100; i++) {
        entity.log.push({ id: `${i}`, timestamp: '', type: 'text', content: `entry-${i}` });
      }
      const steps = [makeStep({ name: 'step0', index: 0, agentKey: entity.uid })];
      widget.setAgents([entity]);
      widget.setSteps(steps);
      widget.setSelectedStepIndex(0);
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
      // Total lines = 5: header(0) + entrySlots(3) + tabBar(4)
      // contentSlots = 3, we show newest 3 entries
      expect(lines[1]).toContain('entry-17');
      expect(lines[2]).toContain('entry-18');
      expect(lines[3]).toContain('entry-19');
      for (let i = 1; i <= 3; i++) {
        expect(lines[i]).toContain('💬');
      }
    });

    it('scroll indicator is a dedicated slot, not a content line', () => {
      const widget = new AgentLogWidget();
      const entity = makeAgent({ agentId: 'a1', profile: 'coder', phaseId: 'test' });
      for (let i = 0; i < 50; i++) {
        entity.log.push({ id: `${i}`, timestamp: '', type: 'text', content: `entry-${i}` });
      }
      const steps = [makeStep({ name: 'step0', index: 0, agentKey: entity.uid })];
      widget.setAgents([entity]);
      widget.setSteps(steps);
      widget.setSelectedStepIndex(0);

      widget.toggleExpand();
      widget.render(80);

      for (let i = 0; i < 5; i++) widget.handleInput(UP_ARROW);

      const lines = widget.render(80);
      expect(lines.length).toBe(40);
      expect(lines[1]).toContain('up arrow');
      expect(lines[1]).toContain('5');
      expect(lines[2]).toContain('💬');
      expect(lines[38]).toContain('💬');
    });

    it('scroll indicator absent when not scrolled — full content slots used', () => {
      const widget = new AgentLogWidget();
      const entity = makeAgent({ agentId: 'a1', profile: 'coder', phaseId: 'test' });
      for (let i = 0; i < 50; i++) {
        entity.log.push({ id: `${i}`, timestamp: '', type: 'text', content: `entry-${i}` });
      }
      const steps = [makeStep({ name: 'step0', index: 0, agentKey: entity.uid })];
      widget.setAgents([entity]);
      widget.setSteps(steps);
      widget.setSelectedStepIndex(0);
      widget.toggleExpand();

      const lines = widget.render(80);
      expect(lines.length).toBe(40);
      expect(lines[1]).not.toContain('up arrow');
      // entrySlots = 38, so lines[1]..lines[38] are entries, lines[39] is tab bar
      for (let i = 1; i <= 38; i++) {
        expect(lines[i]).toContain('💬');
      }
    });

    it('scrollOffset consistent: pressing up N times then render shows N (no snap/jump)', () => {
      const widget = new AgentLogWidget();
      const entity = makeAgent({ agentId: 'a1', profile: 'coder', phaseId: 'test' });
      for (let i = 0; i < 50; i++) {
        entity.log.push({ id: `${i}`, timestamp: '', type: 'text', content: `entry-${i}` });
      }
      const steps = [makeStep({ name: 'step0', index: 0, agentKey: entity.uid })];
      widget.setAgents([entity]);
      widget.setSteps(steps);
      widget.setSelectedStepIndex(0);
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

  // ─── Review fixes (H1 / M1) ────────────────────────────────────────

  describe('Review fixes (H1 / M1)', () => {
    it('header keeps controls visible on a very long title', () => {
      const widget = new AgentLogWidget(5);
      const a1 = makeAgent({
        agentId: 'a1',
        profile: 'coder',
        phaseId: 'test',
        uid: 'key-0',
        taskTitle: 'A'.repeat(60),
      });
      const steps = [makeStep({ name: 'step0', index: 0, agentKey: 'key-0' })];
      widget.setAgents([a1]);
      widget.setSteps(steps);
      widget.setSelectedStepIndex(0);

      const lines = widget.render(60);
      expect(lines.length).toBe(widget.getExpandedLineCount());
      expect(lines[0]).toContain('space');
      expect(lines[0]).toContain('expand');
      const ellipsisIdx = lines[0].indexOf('…');
      const controlsIdx = lines[0].indexOf('space');
      expect(ellipsisIdx).toBeGreaterThanOrEqual(0);
      expect(controlsIdx).toBeGreaterThan(ellipsisIdx);
    });

    it('scrolling when expanded sets user-pinned (no auto-switch after scroll)', () => {
      const widget = new AgentLogWidget(5);
      const agent = makeAgent({ agentId: 'a1', profile: 'coder', phaseId: 'test', uid: 'key-0' });
      const steps = [makeStep({ name: 'step0', index: 0, agentKey: 'key-0' })];
      widget.setAgents([agent]);
      widget.setSteps(steps);
      widget.setSelectedStepIndex(0);

      for (let i = 0; i < 60; i++) {
        agent.log.push({ id: `${i}`, timestamp: '', type: 'text', content: `entry-${i}` });
      }
      widget.invalidate();

      widget.toggleExpand();
      widget.render(80);

      widget.handleInput(UP_ARROW);
      widget.render(80);

      // Scroll sets userPinnedStep = true
      // (no auto-switch to worry about since there's only one agent)
      expect(widget.getSelectedAgentUid()).toBe('key-0');
    });

    it('render line count is exactly getExpandedLineCount() with many entries after EFF-1 guard', () => {
      const widget = new AgentLogWidget();
      const entity = makeAgent({ agentId: 'a', profile: 'p', phaseId: 'test' });
      for (let i = 0; i < 100; i++) {
        entity.log.push({ id: `${i}`, timestamp: '', type: 'text', content: `entry-${i}` });
      }
      const steps = [makeStep({ name: 'step0', index: 0, agentKey: entity.uid })];
      widget.setAgents([entity]);
      widget.setSteps(steps);
      widget.setSelectedStepIndex(0);
      widget.toggleExpand();
      widget.invalidate();

      const lines = widget.render(80);
      expect(lines.length).toBe(40);
      expect(lines.some((l) => l.includes('entry-99'))).toBe(true);
      // entrySlots = 38, contentSlots = 38 (not scrolled). With 100 entries,
      // startIdx = max(0, 100 - 38) = 62, so visible entries are 62..99
      expect(lines.some((l) => l.includes('entry-62'))).toBe(true);
      expect(lines[38]).toContain('entry-99');
    });
  });

  // ─── setSelectedStepIndex scroll guard when expanded (req 5) ─────────
  //
  // Requirement: when the agent log is EXPANDED, follow-driven calls to
  // setSelectedStepIndex (the Dashboard sync entry point) must NOT destroy
  // the user's scroll position — but _selectedStepIndex must still update so
  // the tab-bar highlight stays in sync.  When COLLAPSED the reset still
  // occurs (it is effectively a no-op there because scrollOffset is always 0
  // while collapsed — toggleExpand resets it and the scroll keys are inert —
  // but the step update remains unconditional in both states).
  describe('setSelectedStepIndex scroll guard when expanded (req 5)', () => {
    // Read the (private) scroll offset for precise assertions.
    function scrollOffsetOf(w: AgentLogWidget): number {
      return (w as unknown as { _scrollOffset: number })._scrollOffset;
    }

    /**
     * Build a widget with two steps (each backed by its own agent) where both
     * agents have plenty of log entries so scrolling is meaningful for EITHER
     * step (entrySlots = 38 when expanded; 80 entries → maxScrollOffset = 42).
     */
    function buildTwoStepWidget(expanded: boolean): AgentLogWidget {
      const widget = new AgentLogWidget(10);
      const agent0 = makeAgent({ agentId: 'a0', profile: 'p0', phaseId: 'test', uid: 'key-0' });
      const agent1 = makeAgent({ agentId: 'a1', profile: 'p1', phaseId: 'test', uid: 'key-1' });
      for (let i = 0; i < 80; i++) {
        agent0.log.push({ id: `a0-${i}`, timestamp: '', type: 'text', content: `agent0-entry-${i}` });
        agent1.log.push({ id: `a1-${i}`, timestamp: '', type: 'text', content: `agent1-entry-${i}` });
      }
      const steps: StepEntity[] = [
        makeStep({ name: 'step0', index: 0, agentKey: 'key-0' }),
        makeStep({ name: 'step1', index: 1, agentKey: 'key-1' }),
      ];
      widget.setAgents([agent0, agent1]);
      widget.setSteps(steps);
      widget.setSelectedStepIndex(0);
      if (expanded) widget.toggleExpand();
      return widget;
    }

    it('preserves scrollOffset when expanded while still updating the selected step', () => {
      const widget = buildTwoStepWidget(true);
      expect(widget.isExpanded()).toBe(true);

      // Scroll up by 10 (shift+up) so scrollOffset becomes non-zero.
      widget.render(80); // populate _lastTotalEntryLines for step 0
      widget.handleInput(SHIFT_UP);
      const beforeLines = widget.render(80);

      // Sanity: we really are scrolled.
      expect(scrollOffsetOf(widget)).toBe(10);
      expect(beforeLines[1]).toContain('up arrow');
      expect(beforeLines[1]).toMatch(/up arrow 10 more lines/);

      // ── Dashboard sync entry point: change step while EXPANDED ──
      widget.setSelectedStepIndex(1);

      // The selected step MUST still update (unconditional assignment).
      expect(widget.getSelectedAgentUid()).toBe('key-1');

      // The scroll position MUST be preserved (NOT reset to 0).
      expect(scrollOffsetOf(widget)).toBe(10);
      const afterLines = widget.render(80);
      expect(afterLines[1]).toContain('up arrow');
      expect(afterLines[1]).toMatch(/up arrow 10 more lines/);

      // The rendered content now reflects the newly-selected agent's log.
      expect(afterLines.some((l) => l.includes('agent1-entry-'))).toBe(true);

      // Tab bar now highlights the newly-selected step (step1: bold + underline).
      const tabBar = afterLines[afterLines.length - 1];
      expect(tabBar).toContain('step1');
      expect(tabBar).toContain('\x1b[1m'); // bold
      expect(tabBar).toContain('\x1b[4m'); // underline
    });

    it('keeps scrollOffset intact across repeated setSelectedStepIndex calls while expanded', () => {
      const widget = buildTwoStepWidget(true);
      widget.render(80);
      widget.handleInput(SHIFT_UP);
      widget.render(80);
      expect(scrollOffsetOf(widget)).toBe(10);

      // step 0 → 1 (expanded): scroll preserved
      widget.setSelectedStepIndex(1);
      expect(widget.getSelectedAgentUid()).toBe('key-1');
      expect(scrollOffsetOf(widget)).toBe(10);

      // step 1 → 0 (expanded): scroll still preserved
      widget.setSelectedStepIndex(0);
      expect(widget.getSelectedAgentUid()).toBe('key-0');
      expect(scrollOffsetOf(widget)).toBe(10);

      const lines = widget.render(80);
      expect(lines[1]).toMatch(/up arrow 10 more lines/);
    });

    it('collapsed: setSelectedStepIndex still updates the step and leaves scrollOffset at 0', () => {
      // While collapsed there is never a non-zero scrollOffset (toggleExpand
      // resets it and the scroll keys are inert while collapsed), so the reset
      // is a no-op — but the step update must remain unconditional.
      const widget = buildTwoStepWidget(false);
      expect(widget.isExpanded()).toBe(false);
      expect(scrollOffsetOf(widget)).toBe(0);

      widget.setSelectedStepIndex(1);

      expect(widget.getSelectedAgentUid()).toBe('key-1');
      expect(scrollOffsetOf(widget)).toBe(0);

      const lines = widget.render(80);
      expect(lines[1]).not.toContain('up arrow');
      // Tab bar highlights the newly-selected step.
      expect(lines[lines.length - 1]).toContain('step1');
    });
  });
});
