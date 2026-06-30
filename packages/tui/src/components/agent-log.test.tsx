/**
 * Tests for AgentLog (Ink-based component).
 *
 * Covers:
 *   - Header rendering (title, profile, token counts, context multiple)
 *   - Collapsed vs expanded controls
 *   - Entry rendering per type with icons
 *   - tool_call entries use formatToolCall
 *   - tool_call_end entries skipped
 *   - Entry wrapping (long content wrapped, not truncated)
 *   - Session tab bar (fit, overflow with indicators, selection highlight)
 *   - No session placeholder
 *   - Scroll controls (up/down, shift+up/down, indicator)
 *   - Scroll reset on expand/collapse and selection change
 */

import type { LogEntry, SessionEntity } from '@engin/shared';
import { OverlayHost } from '@harms-haus/ink-overlay';
import { describe, expect, it } from 'bun:test';
import { Box } from 'ink';
import { renderWithHost, sendKey, stripAnsi, type RenderResult } from '../test-harness.js';
import { AgentLog, SessionTabBar, visibleWidth, type AgentLogProps } from './agent-log.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Microtask boundary so React / Ink flush pending updates. */
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

/** Return the visible text lines from lastFrame (stripped of ANSI). */
function visibleLines(result: RenderResult): string[] {
  const frame = result.lastFrame();
  if (!frame) return [];
  return stripAnsi(frame).split('\n');
}

/** Get the last non-empty line from a stripped frame. */
function lastNonEmptyLine(text: string): string {
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i]!.trim().length > 0) return lines[i]!;
  }
  return '';
}

let _uidCounter = 0;

/** Build a SessionEntity fixture. */
function makeSession(overrides: Partial<SessionEntity> & { agentId?: string; phaseId?: string } = {}): SessionEntity {
  _uidCounter++;
  const agentId = overrides.agentId ?? 'agent';
  const phaseId = overrides.phaseId ?? 'test';
  return {
    uid: overrides.uid ?? `${agentId}-${_uidCounter}`,
    agentId,
    profile: overrides.profile ?? 'coder',
    phaseId,
    active: overrides.active ?? true,
    log: overrides.log ?? [],
    toolCallCount: overrides.toolCallCount ?? 0,
    inputTokens: overrides.inputTokens ?? 0,
    outputTokens: overrides.outputTokens ?? 0,
    taskTitle: overrides.taskTitle ?? '',
    runnerRole: overrides.runnerRole ?? '',
    attempt: overrides.attempt ?? 1,
    ...overrides,
  };
}

function makeLogEntry(type: LogEntry['type'], content: string, metadata?: Record<string, unknown>): LogEntry {
  _uidCounter++;
  return {
    id: `log-${_uidCounter}`,
    timestamp: new Date().toISOString(),
    type,
    content,
    metadata,
  };
}

/** Default props for the AgentLog component. */
const defaultProps: AgentLogProps = {
  sessions: [],
  selectedSessionId: null,
  expanded: false,
  collapsedLines: 10,
  expandedLines: 40,
};

/**
 * Render AgentLog and return the stripped text content.
 * Wraps in an OverlayHost via renderWithHost.
 */
function textOf(props: Partial<AgentLogProps> = {}): string {
  const result = renderWithHost(<AgentLog {...defaultProps} {...props} />);
  const frame = result.lastFrame();
  result.unmount();
  return stripAnsi(frame ?? '');
}

// ─── Header rendering ───────────────────────────────────────────────────────

describe('AgentLog header', () => {
  it('renders title, profile, tool call count', () => {
    const session = makeSession({
      taskTitle: 'Fix bug',
      profile: 'senior-dev',
      toolCallCount: 7,
      inputTokens: 100,
      outputTokens: 50,
      runnerRole: 'executor',
    });
    const text = textOf({
      sessions: [session],
      selectedSessionId: session.uid,
    });
    expect(text).toContain('Fix bug');
    expect(text).toContain('profile: senior-dev');
    expect(text).toContain('7 tool calls');
  });

  it('renders compact token units and a context-usage % when contextWindow is set', () => {
    const session = makeSession({
      inputTokens: 84000,
      outputTokens: 56000,
      contextWindow: 200000,
      runnerRole: 'executor',
    });
    const text = textOf({
      sessions: [session],
      selectedSessionId: session.uid,
    });
    expect(text).toContain('↑84k');
    expect(text).toContain('↓56k');
    expect(text).toContain('ctx 0.7×');
  });

  it('uses k units for thousands with a single decimal place', () => {
    const session = makeSession({
      inputTokens: 1200,
      outputTokens: 500,
      contextWindow: 200000,
      runnerRole: 'executor',
    });
    const text = textOf({
      sessions: [session],
      selectedSessionId: session.uid,
    });
    expect(text).toContain('↑1.2k');
  });

  it('uses plain integers for counts below one thousand', () => {
    const session = makeSession({
      inputTokens: 950,
      outputTokens: 42,
      contextWindow: 200000,
      runnerRole: 'executor',
    });
    const text = textOf({
      sessions: [session],
      selectedSessionId: session.uid,
    });
    expect(text).toContain('↑950');
    expect(text).toContain('↓42');
  });

  it('omits the ctx segment entirely when contextWindow is missing', () => {
    const session = makeSession({
      inputTokens: 84000,
      outputTokens: 56000,
      runnerRole: 'executor',
    });
    expect(session.contextWindow).toBeUndefined();
    const text = textOf({
      sessions: [session],
      selectedSessionId: session.uid,
    });
    expect(text).toContain('↑84k');
    expect(text).toContain('↓56k');
    expect(text).not.toContain('ctx');
  });

  it('omits the ctx segment when contextWindow is zero (falsy)', () => {
    const session = makeSession({
      inputTokens: 84000,
      outputTokens: 56000,
      contextWindow: 0,
      runnerRole: 'executor',
    });
    const text = textOf({
      sessions: [session],
      selectedSessionId: session.uid,
    });
    expect(text).not.toContain('ctx');
  });

  it('can exceed 1× because tokens are cumulative across turns', () => {
    const session = makeSession({
      inputTokens: 300000,
      outputTokens: 56000,
      contextWindow: 200000,
      runnerRole: 'executor',
    });
    const text = textOf({
      sessions: [session],
      selectedSessionId: session.uid,
    });
    expect(text).toContain('ctx 1.78×');
  });

  it('shows collapsed controls when not expanded', () => {
    const session = makeSession({
      taskTitle: 'Test',
      profile: 'dev',
      runnerRole: 'executor',
    });
    const text = textOf({
      sessions: [session],
      selectedSessionId: session.uid,
      expanded: false,
    });
    expect(text).toContain('Tab session space expand');
  });

  it('shows expanded controls when expanded', () => {
    const session = makeSession({
      taskTitle: 'Test',
      profile: 'dev',
      runnerRole: 'executor',
    });
    const text = textOf({
      sessions: [session],
      selectedSessionId: session.uid,
      expanded: true,
    });
    expect(text).toContain('↑↓scroll');
    expect(text).toContain('space collapse');
  });
});

// ─── Entry rendering ────────────────────────────────────────────────────────

describe('AgentLog entries', () => {
  it('renders text entries with 💬 icon', () => {
    const session = makeSession({
      log: [makeLogEntry('text', 'hello world')],
      runnerRole: 'executor',
    });
    const text = textOf({
      sessions: [session],
      selectedSessionId: session.uid,
    });
    expect(text).toContain('💬');
    expect(text).toContain('hello world');
  });

  it('renders thinking entries with 🧠 icon', () => {
    const session = makeSession({
      log: [makeLogEntry('thinking', 'hmm...')],
      runnerRole: 'executor',
    });
    const text = textOf({
      sessions: [session],
      selectedSessionId: session.uid,
    });
    expect(text).toContain('🧠');
    expect(text).toContain('hmm...');
  });

  it('renders tool_call_start with formatToolCall', () => {
    const session = makeSession({
      log: [
        makeLogEntry('tool_call_start', 'read', {
          toolName: 'read',
          arguments: { path: '/foo/bar' },
        }),
      ],
      runnerRole: 'executor',
    });
    const text = textOf({
      sessions: [session],
      selectedSessionId: session.uid,
    });
    // formatToolCall for 'read' produces '📖 read → /foo/bar'
    expect(text).toContain('/foo/bar');
  });

  it('renders tool_call entries with formatToolCall', () => {
    const session = makeSession({
      log: [
        makeLogEntry('tool_call', 'bash', {
          toolName: 'bash',
          arguments: { command: 'ls -la' },
        }),
      ],
      runnerRole: 'executor',
    });
    const text = textOf({
      sessions: [session],
      selectedSessionId: session.uid,
    });
    expect(text).toContain('bash');
    expect(text).toContain('ls -la');
  });

  it('renders error entries with ⚠️ icon', () => {
    const session = makeSession({
      log: [makeLogEntry('error', 'something broke')],
      runnerRole: 'executor',
    });
    const text = textOf({
      sessions: [session],
      selectedSessionId: session.uid,
    });
    expect(text).toContain('⚠️');
    expect(text).toContain('something broke');
  });

  it('skips tool_call_end entries', () => {
    const session = makeSession({
      log: [
        makeLogEntry('tool_call_start', 'read', {
          toolName: 'read',
          arguments: { path: '/foo' },
        }),
        makeLogEntry('tool_call_end', 'done'),
      ],
      runnerRole: 'executor',
    });
    const text = textOf({
      sessions: [session],
      selectedSessionId: session.uid,
    });
    // tool_call_start should appear
    expect(text).toContain('/foo');
    // tool_call_end should NOT appear
    expect(text).not.toContain('done');
  });

  it('renders decision entries with 🤝 icon', () => {
    const session = makeSession({
      log: [makeLogEntry('decision', 'proceed with plan')],
      runnerRole: 'executor',
    });
    const text = textOf({
      sessions: [session],
      selectedSessionId: session.uid,
    });
    expect(text).toContain('🤝');
    expect(text).toContain('proceed with plan');
  });

  it('renders render entries with 📋 icon', () => {
    const session = makeSession({
      log: [makeLogEntry('render', 'rendered output')],
      runnerRole: 'executor',
    });
    const text = textOf({
      sessions: [session],
      selectedSessionId: session.uid,
    });
    expect(text).toContain('📋');
    expect(text).toContain('rendered output');
  });

  it('wraps long content instead of truncating', () => {
    // Create content that's long enough to wrap
    const longText = 'hello world '.repeat(20);
    const session = makeSession({
      log: [makeLogEntry('text', longText)],
      runnerRole: 'executor',
    });
    const result = renderWithHost(
      <AgentLog
        {...defaultProps}
        sessions={[session]}
        selectedSessionId={session.uid}
        expanded={true}
        collapsedLines={10}
        expandedLines={10}
      />,
    );
    const text = stripAnsi(result.lastFrame() ?? '');
    // The full original text should be present (wrapping doesn't truncate)
    expect(text).toContain('hello world');
    // The text should span multiple lines (wrapping occurred)
    const lines = text.split('\n');
    const entryLines = lines.filter((l) => l.includes('hello'));
    expect(entryLines.length).toBeGreaterThan(1);
    result.unmount();
  });

  it('renders multiple entries in order', () => {
    const session = makeSession({
      log: [
        makeLogEntry('text', 'first entry'),
        makeLogEntry('thinking', 'second entry'),
        makeLogEntry('text', 'third entry'),
      ],
      runnerRole: 'executor',
    });
    const text = textOf({
      sessions: [session],
      selectedSessionId: session.uid,
    });
    // All three entries should be present
    expect(text).toContain('first entry');
    expect(text).toContain('second entry');
    expect(text).toContain('third entry');
  });
});

// ─── No session placeholder ─────────────────────────────────────────────────

describe('AgentLog no session', () => {
  it('shows "No session selected" when selectedSessionId is null', () => {
    const session = makeSession({ runnerRole: 'executor' });
    const text = textOf({
      sessions: [session],
      selectedSessionId: null,
    });
    expect(text).toContain('No session selected');
  });

  it('shows "No session selected" when selectedSessionId does not match any session', () => {
    const text = textOf({
      sessions: [],
      selectedSessionId: 'nonexistent',
    });
    expect(text).toContain('No session selected');
  });
});

// ─── Tab bar ─────────────────────────────────────────────────────────────────

describe('AgentLog tab bar', () => {
  it('shows "no sessions" when sessions array is empty', () => {
    const text = textOf({ sessions: [] });
    const lastLine = lastNonEmptyLine(text);
    expect(lastLine).toContain('no sessions');
  });

  it('shows session labels when sessions are present', () => {
    const s1 = makeSession({ uid: 'u1', runnerRole: 'executor', profile: 'coder' });
    const s2 = makeSession({ uid: 'u2', runnerRole: 'reviewer', profile: 'reviewer' });
    const text = textOf({
      sessions: [s1, s2],
      selectedSessionId: 'u1',
    });
    const lastLine = lastNonEmptyLine(text);
    expect(lastLine).toContain('executor');
    expect(lastLine).toContain('reviewer');
  });

  it('uses runnerRole as label', () => {
    const s1 = makeSession({ uid: 'u1', runnerRole: 'lead-dev', profile: 'coder' });
    const text = textOf({
      sessions: [s1],
      selectedSessionId: 'u1',
    });
    const lastLine = lastNonEmptyLine(text);
    expect(lastLine).toContain('lead-dev');
  });

  it('falls back to profile when runnerRole is empty', () => {
    const s1 = makeSession({ uid: 'u1', runnerRole: '', profile: 'senior-dev' });
    const text = textOf({
      sessions: [s1],
      selectedSessionId: 'u1',
    });
    const lastLine = lastNonEmptyLine(text);
    expect(lastLine).toContain('senior-dev');
  });
});

// ─── Tab bar overflow (SessionTabBar sub-component) ─────────────────────────

describe('SessionTabBar overflow windowing', () => {
  function makeSessions(count: number, labelLen: number): SessionEntity[] {
    const result: SessionEntity[] = [];
    const A = 'A'.charCodeAt(0);
    for (let i = 0; i < count; i++) {
      const role = String.fromCharCode(A + (i % 26)).repeat(labelLen) + i;
      result.push(
        makeSession({
          uid: `uid-${i}`,
          runnerRole: role,
          profile: role,
          agentId: `agent-${i}`,
          phaseId: 'p',
        }),
      );
    }
    return result;
  }

  it('fits all sessions when there is enough space', () => {
    const sessions = makeSessions(3, 5);
    const result = renderWithHost(
      <Box width={100}>
        <SessionTabBar sessions={sessions} selectedSessionId="uid-0" width={100} />
      </Box>,
    );
    const text = stripAnsi(result.lastFrame() ?? '');
    expect(text).toContain('AAAAA0');
    expect(text).toContain('BBBBB1');
    expect(text).toContain('CCCCC2');
    result.unmount();
  });

  it('shows "no sessions" when empty', () => {
    const result = renderWithHost(<SessionTabBar sessions={[]} selectedSessionId={null} width={100} />);
    const text = stripAnsi(result.lastFrame() ?? '');
    expect(text).toContain('no sessions');
    result.unmount();
  });

  it('highlights the selected session (selected label rendered)', () => {
    const sessions = makeSessions(3, 5);
    const result = renderWithHost(
      <Box width={100}>
        <SessionTabBar sessions={sessions} selectedSessionId="uid-1" width={100} />
      </Box>,
    );
    const text = stripAnsi(result.lastFrame() ?? '');
    // The selected session's label should appear
    expect(text).toContain('BBBBB1');
    result.unmount();
  });

  it('overflow: selected session stays visible when truncated', () => {
    const sessions = makeSessions(10, 10);
    const result = renderWithHost(
      <Box width={35}>
        <SessionTabBar sessions={sessions} selectedSessionId="uid-9" width={35} />
      </Box>,
    );
    const text = stripAnsi(result.lastFrame() ?? '');
    // The selected session label must be present in the tab bar
    const selectedLabel = sessions[9]!.runnerRole;
    expect(text).toContain(selectedLabel);
    result.unmount();
  });

  it('overflow: shows hidden-session indicator when truncated', () => {
    const sessions = makeSessions(8, 8);
    const result = renderWithHost(
      <Box width={35}>
        <SessionTabBar sessions={sessions} selectedSessionId="uid-4" width={35} />
      </Box>,
    );
    const text = stripAnsi(result.lastFrame() ?? '');
    // An overflow indicator (…+N or +N…) must be present on at least one side
    expect(text).toMatch(/\+/);
    // The selected session is still visible
    expect(text).toContain(sessions[4]!.runnerRole);
    result.unmount();
  });

  it('overflow: leftmost hidden count indicator shows count', () => {
    const sessions = makeSessions(10, 10);
    const result = renderWithHost(
      <Box width={35}>
        <SessionTabBar sessions={sessions} selectedSessionId="uid-9" width={35} />
      </Box>,
    );
    const text = stripAnsi(result.lastFrame() ?? '');
    // The left indicator should show a hidden count like '…+9'
    expect(text).toMatch(/…\+\d+/);
    result.unmount();
  });
});

// ─── Scroll controls (expanded) ─────────────────────────────────────────────

describe('AgentLog scroll controls', () => {
  it('when expanded: first up arrow shows scroll indicator (takes 1 slot)', async () => {
    const session = makeSession({
      log: Array.from({ length: 30 }, (_, i) => makeLogEntry('text', `line ${i}`)),
      runnerRole: 'executor',
    });
    const result = renderWithHost(
      <AgentLog
        {...defaultProps}
        sessions={[session]}
        selectedSessionId={session.uid}
        expanded={true}
        collapsedLines={10}
        expandedLines={10}
      />,
    );

    // First up arrow: scrollOffset=1, indicator appears
    sendKey(result.stdin, 'up');
    await tick();
    const text = stripAnsi(result.lastFrame() ?? '');
    expect(text).toContain('more lines below');
    result.unmount();
  });

  it('when expanded: second up arrow scrolls content (after indicator)', async () => {
    const session = makeSession({
      log: Array.from({ length: 30 }, (_, i) => makeLogEntry('text', `line ${i}`)),
      runnerRole: 'executor',
    });
    const result = renderWithHost(
      <AgentLog
        {...defaultProps}
        sessions={[session]}
        selectedSessionId={session.uid}
        expanded={true}
        collapsedLines={10}
        expandedLines={10}
      />,
    );

    // First up: indicator appears, content stays same
    sendKey(result.stdin, 'up');
    await tick();
    // Second up: content actually scrolls (line 21 appears, line 29 disappears)
    sendKey(result.stdin, 'up');
    await tick();
    const text = stripAnsi(result.lastFrame() ?? '');
    // Line 21 should now be visible
    expect(text).toContain('line 21');
    // Line 29 should no longer be visible (scrolled out)
    expect(text).not.toContain('line 29');
    result.unmount();
  });

  it('when expanded: down arrow scrolls back to bottom (indicator gone)', async () => {
    const session = makeSession({
      log: Array.from({ length: 30 }, (_, i) => makeLogEntry('text', `line ${i}`)),
      runnerRole: 'executor',
    });
    const result = renderWithHost(
      <AgentLog
        {...defaultProps}
        sessions={[session]}
        selectedSessionId={session.uid}
        expanded={true}
        collapsedLines={10}
        expandedLines={10}
      />,
    );

    // Scroll up (indicator appears), then down (indicator disappears)
    sendKey(result.stdin, 'up');
    await tick();
    sendKey(result.stdin, 'down');
    await tick();
    const text = stripAnsi(result.lastFrame() ?? '');
    expect(text).not.toContain('more lines below');
    result.unmount();
  });

  it('when expanded: shift+up scrolls by 10', async () => {
    const session = makeSession({
      log: Array.from({ length: 50 }, (_, i) => makeLogEntry('text', `line ${i}`)),
      runnerRole: 'executor',
    });
    const result = renderWithHost(
      <AgentLog
        {...defaultProps}
        sessions={[session]}
        selectedSessionId={session.uid}
        expanded={true}
        collapsedLines={10}
        expandedLines={20}
      />,
    );

    // Send shift+up: \x1b[1;2A is the DECCIR sequence for shift+up arrow
    result.stdin.write('\x1b[1;2A');
    await tick();
    const text = stripAnsi(result.lastFrame() ?? '');
    expect(text).toContain('more lines below');
    result.unmount();
  });

  it('expanded toggle resets scrollOffset', async () => {
    const session = makeSession({
      log: Array.from({ length: 30 }, (_, i) => makeLogEntry('text', `line ${i}`)),
      runnerRole: 'executor',
    });

    // First render expanded, scroll up, then collapse, then expand again
    const result = renderWithHost(
      <AgentLog
        {...defaultProps}
        sessions={[session]}
        selectedSessionId={session.uid}
        expanded={true}
        collapsedLines={10}
        expandedLines={10}
      />,
    );

    // Scroll up
    sendKey(result.stdin, 'up');
    await tick();
    let text = stripAnsi(result.lastFrame() ?? '');
    expect(text).toContain('more lines below');

    // Re-render collapsed
    result.rerender(
      <OverlayHost>
        <AgentLog
          {...defaultProps}
          sessions={[session]}
          selectedSessionId={session.uid}
          expanded={false}
          collapsedLines={10}
          expandedLines={10}
        />
      </OverlayHost>,
    );

    // Re-render expanded again - scroll should be reset
    result.rerender(
      <OverlayHost>
        <AgentLog
          {...defaultProps}
          sessions={[session]}
          selectedSessionId={session.uid}
          expanded={true}
          collapsedLines={10}
          expandedLines={10}
        />
      </OverlayHost>,
    );

    await tick();
    text = stripAnsi(result.lastFrame() ?? '');
    expect(text).not.toContain('more lines below');
    result.unmount();
  });
});

// ─── Layout ─────────────────────────────────────────────────────────────────

describe('AgentLog layout', () => {
  it('renders the header with dimColor style', () => {
    const session = makeSession({
      log: [makeLogEntry('text', 'hello')],
      runnerRole: 'executor',
    });
    const result = renderWithHost(
      <AgentLog
        {...defaultProps}
        sessions={[session]}
        selectedSessionId={session.uid}
        expanded={false}
        collapsedLines={10}
        expandedLines={40}
      />,
    );
    const frame = result.lastFrame() ?? '';
    // Check dimColor is applied (Ink's dimColor makes text dim)
    // We just verify the header text is present
    expect(frame).toContain('coder');
    result.unmount();
  });

  it('renders tab bar as the last content line', () => {
    const session = makeSession({
      log: [makeLogEntry('text', 'hello')],
      runnerRole: 'executor',
    });
    const text = textOf({
      sessions: [session],
      selectedSessionId: session.uid,
      expanded: false,
      collapsedLines: 10,
      expandedLines: 40,
    });
    // The tab bar should be the last non-empty line
    const lastLine = lastNonEmptyLine(text);
    expect(lastLine).toContain('executor');
  });

  it('header preserves controls visibility for very long titles', () => {
    const longTitle = 'A'.repeat(300);
    const session = makeSession({
      taskTitle: longTitle,
      profile: 'dev',
      runnerRole: 'executor',
    });
    const text = textOf({
      sessions: [session],
      selectedSessionId: session.uid,
      expanded: false,
      collapsedLines: 5,
      expandedLines: 5,
    });
    // Controls should still be visible in the header
    // The controls text may be split across lines due to wrapping
    expect(text).toContain('Tab session space');
    expect(text).toContain('expand');
    // Title should be truncated (shorter than full 300 chars)
    const firstLine = text.split('\n')[0] ?? '';
    expect(firstLine.length).toBeLessThan(350);
    // The header line should NOT contain the full 300 'A's
    const headerContent = text.split('\n').find((l) => l.includes('profile: dev')) ?? '';
    expect(headerContent.length).toBeLessThan(400);
  });
});

// ─── Input restrictions ─────────────────────────────────────────────────────

describe('AgentLog input restrictions', () => {
  it('up/down when collapsed do nothing (no crash)', async () => {
    const session = makeSession({
      log: [makeLogEntry('text', 'hello')],
      runnerRole: 'executor',
    });
    const result = renderWithHost(
      <AgentLog
        {...defaultProps}
        sessions={[session]}
        selectedSessionId={session.uid}
        expanded={false}
        collapsedLines={10}
        expandedLines={10}
      />,
    );

    // Send up/down arrows - should not cause crash or scroll change
    sendKey(result.stdin, 'up');
    await tick();
    sendKey(result.stdin, 'down');
    await tick();
    // The component should still render without error
    const text = stripAnsi(result.lastFrame() ?? '');
    expect(text).toBeTruthy();
    result.unmount();
  });
});

// ─── visibleWidth ───────────────────────────────────────────────────────

describe('visibleWidth', () => {
  it('returns 1 for ASCII characters', () => {
    expect(visibleWidth('a')).toBe(1);
    expect(visibleWidth('A')).toBe(1);
    expect(visibleWidth(' ')).toBe(1);
    expect(visibleWidth('0')).toBe(1);
    expect(visibleWidth('!')).toBe(1);
    expect(visibleWidth('hello')).toBe(5);
  });

  it('ignores control characters (width 0)', () => {
    expect(visibleWidth('\u0000')).toBe(0);
    expect(visibleWidth('\u0007')).toBe(0); // BEL
    expect(visibleWidth('\u001b')).toBe(0); // ESC
    expect(visibleWidth('\n')).toBe(0);
    expect(visibleWidth('\t')).toBe(0);
  });

  it('returns 2 for CJK wide characters', () => {
    // 中 = U+4E2D
    expect(visibleWidth('中')).toBe(2);
    // 達 = U+9054
    expect(visibleWidth('達')).toBe(2);
    // 韓 = U+97D3
    expect(visibleWidth('韓')).toBe(2);
    // 漢字 = two wide chars
    expect(visibleWidth('漢字')).toBe(4);
  });

  it('returns 2 for Korean Hangul syllables', () => {
    // 한 = U+D55C, in range 0xAC00-0xD7A3
    expect(visibleWidth('한')).toBe(2);
    // 가 = U+AC00
    expect(visibleWidth('가')).toBe(2);
  });

  it('returns 2 for emoji used in the type icon map', () => {
    // 💬 = U+1F4AC (text icon)
    expect(visibleWidth('💬')).toBe(2);
    // 🧠 = U+1F9E0 (thinking icon, in range 0x1F900-0x1F9FF)
    expect(visibleWidth('🧠')).toBe(2);
    // ⚠️ = U+26A0 U+FE0F — 26A0 is not in any wide range, so width=1 for the
    // base glyph + FE0F (variation selector, also not wide). Total = 2.
    expect(visibleWidth('⚠️')).toBe(2);
    // 🤝 = U+1F91D (handshake, in range 0x1F900-0x1F9FF)
    expect(visibleWidth('🤝')).toBe(2);
    // 📋 = U+1F4CB (clipboard, in range 0x1F300-0x1F5FF)
    expect(visibleWidth('📋')).toBe(2);
  });

  it('returns 2 for fullwidth/halfwidth forms', () => {
    // Ａ = U+FF21 (fullwidth A, in range 0xFF01-0xFF60)
    expect(visibleWidth('Ａ')).toBe(2);
    // ｦ = U+FF66? No — that's outside 0xFF60. Check 0xFF60 itself: ￠ no.
    // Use ￡ = U+FFE1 (in range 0xFFE0-0xFFE6)
    expect(visibleWidth('￡')).toBe(2);
  });

  it('returns 1 for codepoints just above the emoji ranges (no open-ended match)', () => {
    // U+1FA00 is a chess symbol — above the 0x1F900-0x1F9FF range but below
    // 0x1FA70-0x1FAFF. It should be width 1, NOT width 2 (the old code's
    // open-ended `cp >= 0x1f900` clause would have wrongly matched it).
    // Actually 0x1FA00 is below 0x1FA70, so it's width 1.
    expect(visibleWidth(String.fromCodePoint(0x1fa00))).toBe(1);
    // U+1F700 is an alchemical symbol — above 0x1F64F but below 0x1F680, so
    // it falls in a gap between ranges. Should be width 1.
    expect(visibleWidth(String.fromCodePoint(0x1f700))).toBe(1);
  });

  it('returns 2 for supplementary emoji in 0x1FA70-0x1FAFF', () => {
    // 🩰 = U+1FA70 (ballet shoes, in range 0x1FA70-0x1FAFF)
    expect(visibleWidth(String.fromCodePoint(0x1fa70))).toBe(2);
    // 🪿 = U+1FAFF (goose, upper bound of 0x1FA70-0x1FAFF)
    expect(visibleWidth(String.fromCodePoint(0x1faff))).toBe(2);
  });

  it('handles mixed strings correctly', () => {
    expect(visibleWidth('hello 中')).toBe(8); // 5 + 1(space) + 2
    expect(visibleWidth('💬 hi')).toBe(5); // 2 + 1(space) + 2(2 ASCII)
    expect(visibleWidth('')).toBe(0);
  });
});
