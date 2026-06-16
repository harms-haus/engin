/**
 * Tests for the format-entry utilities AND verification that formatToolCall is
 * sourced from @engin/shared/format-tool-call.
 *
 * `web/src/utils/format-entry.ts` imports:
 *
 *   import { formatToolCall } from '@engin/shared/format-tool-call';
 *
 * (previously '@engin/tui/format-tool-call'). formatToolCall is consumed
 * internally by formatEntryContent and is NOT re-exported, so the migration is
 * verified behaviourally: formatEntryContent's output for tool-call entries must
 * EXACTLY equal what @engin/shared/format-tool-call produces for the same
 * (toolName, arguments). A mismatch would mean the shared import resolved to a
 * different (or broken) formatter.
 *
 * These tests also add previously-missing unit coverage for shouldRenderEntry
 * and formatEntryContent themselves.
 */

import { describe, expect, it } from 'vitest';

// ── NEW canonical home: shared package ──────────────────────────────────────
import { formatToolCall } from '@engin/shared/format-tool-call';

// ── Module under test ───────────────────────────────────────────────────────
import type { LogEntry } from '../protocol-types';
import { formatEntryContent, shouldRenderEntry } from './format-entry';

// ── Helpers ──────────────────────────────────────────────────────────────────

function entry(partial: Partial<LogEntry> & Pick<LogEntry, 'type' | 'content'>): LogEntry {
  return { id: 'log-1', timestamp: '2026-06-15T00:00:00.000Z', ...partial };
}

function toolEntry(type: 'tool_call_start' | 'tool_call', toolName: string, args: Record<string, unknown>): LogEntry {
  return entry({
    type,
    content: toolName,
    metadata: { toolName, arguments: args },
  });
}

// ── shouldRenderEntry ────────────────────────────────────────────────────────

describe('shouldRenderEntry', () => {
  it('hides tool_call_end entries (redundant with tool_call_start)', () => {
    expect(shouldRenderEntry(entry({ type: 'tool_call_end', content: 'read' }))).toBe(false);
  });

  it('renders tool_call_start entries', () => {
    expect(shouldRenderEntry(entry({ type: 'tool_call_start', content: 'read' }))).toBe(true);
  });

  it('renders all non-tool_call_end entry types', () => {
    const types: LogEntry['type'][] = ['text', 'thinking', 'tool_call', 'tool_call_start', 'decision', 'error'];
    for (const type of types) {
      expect(shouldRenderEntry(entry({ type, content: 'x' }))).toBe(true);
    }
  });
});

// ── formatEntryContent — tool-call formatting via @engin/shared/format-tool-call ─

describe('formatEntryContent — routes tool_call_start through formatToolCall', () => {
  it('formats a read tool call matching @engin/shared/format-tool-call output', () => {
    const e = toolEntry('tool_call_start', 'read', { path: 'src/index.ts' });
    expect(formatEntryContent(e)).toBe(formatToolCall('read', { path: 'src/index.ts' }));
    expect(formatEntryContent(e)).toBe('📖 read → src/index.ts');
  });

  it('formats read with offset and limit', () => {
    const e = toolEntry('tool_call_start', 'read', { path: 'src/index.ts', offset: 10, limit: 50 });
    expect(formatEntryContent(e)).toBe(formatToolCall('read', { path: 'src/index.ts', offset: 10, limit: 50 }));
    expect(formatEntryContent(e)).toBe('📖 read → src/index.ts:10+50');
  });

  it('formats write with a line count', () => {
    const e = toolEntry('tool_call_start', 'write', { path: 'a.ts', content: 'line1\nline2\nline3' });
    expect(formatEntryContent(e)).toBe(formatToolCall('write', { path: 'a.ts', content: 'line1\nline2\nline3' }));
    expect(formatEntryContent(e)).toBe('📝 write → a.ts +3');
  });

  it('formats bash commands', () => {
    const e = toolEntry('tool_call_start', 'bash', { command: 'echo hi' });
    expect(formatEntryContent(e)).toBe(formatToolCall('bash', { command: 'echo hi' }));
    expect(formatEntryContent(e)).toBe('💻 bash → echo hi');
  });

  it('uses the legacy "tool_call" type as well as "tool_call_start"', () => {
    const e = toolEntry('tool_call', 'grep', { pattern: 'TODO', path: 'src/' });
    expect(formatEntryContent(e)).toBe(formatToolCall('grep', { pattern: 'TODO', path: 'src/' }));
    expect(formatEntryContent(e)).toBe('🔍 grep → TODO → src/');
  });

  it('falls back to entry.content as toolName when metadata.toolName is absent', () => {
    // content is used as the tool name; empty args → generic fallback shape
    const e = entry({ type: 'tool_call_start', content: 'mystery', metadata: {} });
    expect(formatEntryContent(e)).toBe(formatToolCall('mystery', {}));
    expect(formatEntryContent(e)).toBe('🔧 mystery');
  });

  it('falls back to empty args object when metadata.arguments is absent', () => {
    const e = entry({ type: 'tool_call_start', content: 'mystery', metadata: { toolName: 'mystery' } });
    expect(formatEntryContent(e)).toBe(formatToolCall('mystery', {}));
  });
});

// ── formatEntryContent — non-tool entries pass content through ───────────────

describe('formatEntryContent — returns raw content for non-tool entries', () => {
  it('returns content for text entries', () => {
    expect(formatEntryContent(entry({ type: 'text', content: 'hello world' }))).toBe('hello world');
  });

  it('returns content for thinking entries', () => {
    expect(formatEntryContent(entry({ type: 'thinking', content: 'hmm...' }))).toBe('hmm...');
  });

  it('returns content for decision entries', () => {
    expect(formatEntryContent(entry({ type: 'decision', content: 'go left' }))).toBe('go left');
  });

  it('returns content for error entries', () => {
    expect(formatEntryContent(entry({ type: 'error', content: 'oops' }))).toBe('oops');
  });

  it('returns content for tool_call_end entries (no special formatting)', () => {
    expect(formatEntryContent(entry({ type: 'tool_call_end', content: 'read' }))).toBe('read');
  });
});
