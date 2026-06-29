// ─── Tests for AgentLogWidget header — context % and compact token units ─────
//
// These tests pin the *expected* header rendering after the planned change to
// the `leftRaw` string in `agent-log-widget.ts`:
//
//   • token counts are rendered via `formatTokenCount(...)` (compact units)
//   • a `ctx N×` segment is appended when `contextWindow` is truthy,
//     omitted entirely otherwise. `N×` is a cumulative-consumption multiple
//     of the per-request context window (input + output tokens / window),
//     which can exceed 1× — it is NOT a bounded fill percentage.
//
// NOTE: the implementation has NOT been applied yet, so these tests are RED
// against the current source (raw integer counts + no `ctx` segment). They
// verify the target behaviour described in the task spec.

import { visibleWidth } from '@earendil-works/pi-tui';
import type { SessionEntity } from '@engin/shared';
import { describe, expect, it } from 'bun:test';
import { AgentLogWidget } from './agent-log-widget.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Strip SGR (color/style) escape sequences from a rendered line. */
// eslint-disable-next-line no-control-regex
const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, '');

/**
 * Build an SessionEntity fixture. `contextWindow` is intentionally OMITTED by
 * default so that tests which need it must opt in (mirrors the optional field).
 */
function makeAgent(overrides: Partial<SessionEntity> = {}): SessionEntity {
  return {
    uid: 'agent-1',
    agentId: 'agent-1',
    profile: 'coder',
    phaseId: 'phase-1',
    active: true,
    log: [],
    toolCallCount: 3,
    inputTokens: 84000,
    outputTokens: 56000,
    taskTitle: 'Write tests',
    runnerRole: 'executor',
    attempt: 1,
    ...overrides,
  };
}

/** Render the widget (collapsed) and return the resulting lines. */
function renderCollapsed(agent: SessionEntity, width = 120): string[] {
  const widget = new AgentLogWidget(20);
  widget.setAgents([agent]);
  widget.setSelectedSessionId(agent.uid);
  return widget.render(width);
}

/** The header (render line 0) with ANSI styling stripped. */
const headerOf = (lines: string[]): string => stripAnsi(lines[0]!);

// ─── Token formatting & context % ────────────────────────────────────────────

describe('AgentLogWidget header — compact tokens and context %', () => {
  it('renders compact token units and a context-usage % when contextWindow is set', () => {
    const agent = makeAgent({
      inputTokens: 84000,
      outputTokens: 56000,
      contextWindow: 200000,
    });
    const header = headerOf(renderCollapsed(agent));

    // compact units
    expect(header).toContain('↑84k');
    expect(header).toContain('↓56k');
    // context usage: (84000 + 56000) / 200000 = 0.7 → 0.7×
    expect(header).toContain('ctx 0.7×');

    // raw integers must NOT leak through
    expect(header).not.toContain('↑84000');
    expect(header).not.toContain('↓56000');
  });

  it('formats the full in/out/ctx segment in the documented order', () => {
    // Spec example: `• ↑1.2k • ↓56k • ctx 0.29×`
    const agent = makeAgent({
      inputTokens: 1200,
      outputTokens: 56000,
      contextWindow: 200000,
    });
    const header = headerOf(renderCollapsed(agent));

    expect(header).toContain('↑1.2k • ↓56k • ctx 0.29×');
  });

  it('uses k units for thousands with a single decimal place', () => {
    const agent = makeAgent({ inputTokens: 1200, contextWindow: 200000 });
    const header = headerOf(renderCollapsed(agent));
    expect(header).toContain('↑1.2k');
  });

  it('uses plain integers for counts below one thousand', () => {
    const agent = makeAgent({
      inputTokens: 950,
      outputTokens: 42,
      contextWindow: 200000,
    });
    const header = headerOf(renderCollapsed(agent));
    expect(header).toContain('↑950');
    expect(header).toContain('↓42');
  });

  it('omits the ctx segment entirely when contextWindow is missing', () => {
    const agent = makeAgent({ inputTokens: 84000, outputTokens: 56000 });
    expect(agent.contextWindow).toBeUndefined();

    const header = headerOf(renderCollapsed(agent));

    // tokens are still compact
    expect(header).toContain('↑84k');
    expect(header).toContain('↓56k');
    // but no ctx segment follows
    expect(header).not.toContain('ctx');
    expect(header).not.toMatch(/↓56k • ctx/);
  });

  it('omits the ctx segment when contextWindow is zero (falsy)', () => {
    // Guards against a divide-by-zero and honours the truthiness check.
    const agent = makeAgent({ inputTokens: 84000, contextWindow: 0 });
    const header = headerOf(renderCollapsed(agent));

    expect(header).not.toContain('ctx');
    expect(header).toContain('↑84k');
  });

  it('rounds the context multiple to two decimal places (up)', () => {
    // (86000 + 56000) / 200000 = 0.71 → 0.71×
    const agent = makeAgent({
      inputTokens: 86000,
      outputTokens: 56000,
      contextWindow: 200000,
    });
    const header = headerOf(renderCollapsed(agent));
    expect(header).toContain('ctx 0.71×');
  });

  it('rounds the context multiple to two decimal places (down)', () => {
    // (84999 + 56000) / 200000 = 0.704995 → 0.7×
    const agent = makeAgent({
      inputTokens: 84999,
      outputTokens: 56000,
      contextWindow: 200000,
    });
    const header = headerOf(renderCollapsed(agent));
    expect(header).toContain('ctx 0.7×');
  });

  it('can exceed 1× because tokens are cumulative across turns', () => {
    // 3 turns of ~100k input against a 200k window: cumulative consumption
    // is well above the per-request cap, so the multiple exceeds 1×.
    const agent = makeAgent({
      inputTokens: 300000,
      outputTokens: 56000,
      contextWindow: 200000,
    });
    const header = headerOf(renderCollapsed(agent));
    expect(header).toContain('ctx 1.78×');
  });
});

// ─── Layout / controls / truncation ──────────────────────────────────────────

describe('AgentLogWidget header — layout & controls', () => {
  it('keeps the collapsed controls visible on the right side', () => {
    const agent = makeAgent({ contextWindow: 200000 });
    const header = headerOf(renderCollapsed(agent, 120));
    expect(header).toContain('Tab session space expand');
  });

  it('shows expanded controls when the widget is expanded', () => {
    const agent = makeAgent({ contextWindow: 200000 });
    const widget = new AgentLogWidget(20);
    widget.setAgents([agent]);
    widget.setSelectedSessionId(agent.uid);
    widget.toggleExpand();

    const header = stripAnsi(widget.render(120)[0]!);

    expect(header).toContain('space collapse');
  });

  it('pads the header to exactly the render width', () => {
    const width = 120;
    const lines = renderCollapsed(makeAgent({ contextWindow: 200000 }), width);
    const header = lines[0]!;

    // The header line (incl. controls + padding) should exactly fill the width.
    expect(visibleWidth(header)).toBe(width);
  });

  it('truncates a very long title with an ellipsis while keeping controls visible', () => {
    // Regression guard: the title-truncation logic must still kick in even with
    // the appended ctx segment, reserving room for the controls.
    const longTitle = 'A'.repeat(300);
    const agent = makeAgent({ taskTitle: longTitle, contextWindow: 200000 });
    const header = headerOf(renderCollapsed(agent, 80));

    expect(header).toContain('…');
    expect(header).toContain('Tab session space expand');
  });
});
