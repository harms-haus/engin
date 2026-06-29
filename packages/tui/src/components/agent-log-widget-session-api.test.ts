// ─── Tests for AgentLogWidget session-based selection API ───────────────────

import { visibleWidth } from '@earendil-works/pi-tui';
import type { LogEntry, SessionEntity } from '@engin/shared';
import { describe, expect, it } from 'bun:test';
import { AgentLogWidget } from './agent-log-widget.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

// eslint-disable-next-line no-control-regex
const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, '');

function makeSession(overrides: Partial<SessionEntity> = {}): SessionEntity {
  return {
    uid: 'session-1',
    agentId: 'session-1',
    profile: 'coder',
    phaseId: 'phase-1',
    active: true,
    log: [],
    toolCallCount: 1,
    inputTokens: 1000,
    outputTokens: 500,
    taskTitle: 'Write tests',
    runnerRole: 'executor',
    attempt: 1,
    ...overrides,
  };
}

function makeLogEntry(overrides: Partial<LogEntry> = {}): LogEntry {
  return {
    type: 'text',
    content: 'hello world',
    ...overrides,
  } as LogEntry;
}

// ─── Characterization: rendering after selection via new API ─────────────────

describe('AgentLogWidget — renders correctly after session selection', () => {
  it('renders the selected session header (title + profile) via setSelectedSessionId', () => {
    const session = makeSession({ taskTitle: 'Refactor widget', profile: 'coder' });
    const widget = new AgentLogWidget(20);
    widget.setAgents([session]);
    widget.setSelectedSessionId(session.uid);

    const lines = widget.render(120);
    const header = stripAnsi(lines[0]!);

    expect(header).toContain('Refactor widget');
    expect(header).toContain('profile: coder');
  });

  it('renders log entries from the selected session', () => {
    const session = makeSession({
      log: [makeLogEntry({ type: 'text', content: 'a rendered message' })],
    });
    const widget = new AgentLogWidget(20);
    widget.setAgents([session]);
    widget.setSelectedSessionId(session.uid);

    const rendered = widget.render(120).map(stripAnsi).join('\n');

    expect(rendered).toContain('a rendered message');
  });

  it('renders the session tab bar as the last line, highlighting the selected session', () => {
    const a = makeSession({ uid: 's-a', runnerRole: 'executor' });
    const b = makeSession({ uid: 's-b', runnerRole: 'reviewer' });
    const widget = new AgentLogWidget(20);
    widget.setAgents([a, b]);
    widget.setSessions([a, b]);
    widget.setSelectedSessionId('s-b');

    const lines = widget.render(120);
    const tabBar = stripAnsi(lines[lines.length - 1]!);

    // Both session labels appear in the tab bar.
    expect(tabBar).toContain('executor');
    expect(tabBar).toContain('reviewer');
    // The widget pads its last line to the render width.
    expect(visibleWidth(lines[lines.length - 1]!)).toBe(120);
  });

  it('shows the placeholder when no session is selected', () => {
    const session = makeSession();
    const widget = new AgentLogWidget(20);
    widget.setAgents([session]);
    // never call setSelectedSessionId → stays null
    const rendered = widget.render(120).map(stripAnsi).join('\n');

    expect(rendered).toContain('No session selected');
  });
});

// ─── Contract: session selection round-trip ──────────────────────────────────

describe('AgentLogWidget — session selection get/set contract', () => {
  it('defaults to null when nothing is selected', () => {
    const widget = new AgentLogWidget(20);
    expect(widget.getSelectedSessionId()).toBeNull();
  });

  it('returns the id set via setSelectedSessionId', () => {
    const widget = new AgentLogWidget(20);
    widget.setSelectedSessionId('session-xyz');
    expect(widget.getSelectedSessionId()).toBe('session-xyz');
  });

  it('can be reset back to null', () => {
    const widget = new AgentLogWidget(20);
    widget.setSelectedSessionId('session-xyz');
    widget.setSelectedSessionId(null);
    expect(widget.getSelectedSessionId()).toBeNull();
  });

  it('treats getSelectedSessionId as the source of truth for selection', () => {
    // Whatever id setSelectedSessionId stores is exactly what getSelectedSessionId
    // returns — they must be backed by the same session-selection state.
    const widget = new AgentLogWidget(20);
    for (const id of ['a', 'b', 'c', null, 'd']) {
      widget.setSelectedSessionId(id);
      expect(widget.getSelectedSessionId()).toBe(id);
    }
  });
});

// ─── Public surface: only session-based names are exposed ────────────────────

describe('AgentLogWidget — old misleading agent-uid API names are removed', () => {
  it('does not expose setSelectedAgentUid on the public surface', () => {
    const widget = new AgentLogWidget(20);
    expect((widget as unknown as Record<string, unknown>).setSelectedAgentUid).toBeUndefined();
  });

  it('does not expose getSelectedAgentUid on the public surface', () => {
    const widget = new AgentLogWidget(20);
    expect((widget as unknown as Record<string, unknown>).getSelectedAgentUid).toBeUndefined();
  });

  it('exposes setSelectedSessionId and getSelectedSessionId as functions', () => {
    const widget = new AgentLogWidget(20);
    expect(typeof widget.setSelectedSessionId).toBe('function');
    expect(typeof widget.getSelectedSessionId).toBe('function');
  });
});
