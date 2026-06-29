// Tests for the unified event-log line formatter in
// `@engin/shared/format-workflow-event`.
//
// These pin the observable formatting behavior of `formatWorkflowEventLine`
// directly (NOT through a consuming store), so a regression in the formatter
// surfaces as a content assertion failure rather than a circular
// "store output equals the same function call" check.
//
// Coverage focuses on the auto-retry event kinds; the broader lifecycle
// formatting is exercised through the consuming stores' own tests.

import { describe, expect, it } from 'bun:test';
import type { EventRecord } from './event-types.js';
import { formatWorkflowEventLine } from './format-workflow-event.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

function ev(
  type: EventRecord['type'],
  data: Record<string, unknown> = {},
  meta: Partial<EventRecord['metadata']> = {},
  seq = 1,
): EventRecord {
  return {
    seq,
    type,
    data,
    metadata: { timestamp: '2026-06-15T00:00:00.000Z', ...meta },
  };
}

// ── auto_retry_started ───────────────────────────────────────────────────────

describe('formatWorkflowEventLine — auto_retry_started', () => {
  it('renders attempt/maxAttempts, delay, and errorMessage when all present', () => {
    const line = formatWorkflowEventLine(
      ev(
        'auto_retry_started',
        { attempt: 2, maxAttempts: 5, delayMs: 1000, errorMessage: 'rate limited' },
        { agentId: 'a1' },
        10,
      ),
    );
    expect(line).not.toBeNull();
    expect(line as string).toContain('2/5');
    expect(line as string).toContain('1s');
    expect(line as string).toContain('rate limited');
  });

  it('omits the errorMessage suffix when none is provided', () => {
    const line = formatWorkflowEventLine(
      ev('auto_retry_started', { attempt: 1, maxAttempts: 3, delayMs: 500 }, { agentId: 'a1' }, 11),
    );
    expect(line).not.toBeNull();
    expect(line as string).toContain('1/3');
    expect(line as string).toContain('500ms');
    // No trailing colon/empty ": " when errorMessage is absent.
    expect(line as string).not.toContain(': ');
  });

  it('omits the delay suffix when delayMs is 0', () => {
    const line = formatWorkflowEventLine(
      ev('auto_retry_started', { attempt: 1, maxAttempts: 3, delayMs: 0 }, { agentId: 'a1' }, 12),
    );
    expect(line).not.toBeNull();
    expect(line as string).toContain('1/3');
    // delayStr is empty for delayMs <= 0, so no " in " segment.
    expect(line as string).not.toContain(' in ');
  });

  it('formats a sub-second delay in milliseconds', () => {
    const line = formatWorkflowEventLine(
      ev('auto_retry_started', { attempt: 1, maxAttempts: 2, delayMs: 250 }, { agentId: 'a1' }, 13),
    );
    expect(line).not.toBeNull();
    expect(line as string).toContain(' in 250ms');
  });

  it('formats a fractional-second delay with trimmed trailing zeros', () => {
    const line = formatWorkflowEventLine(
      ev('auto_retry_started', { attempt: 1, maxAttempts: 2, delayMs: 1500 }, { agentId: 'a1' }, 14),
    );
    expect(line).not.toBeNull();
    expect(line as string).toContain(' in 1.5s');
  });

  it('defaults missing attempt/maxAttempts to 1/1', () => {
    const line = formatWorkflowEventLine(ev('auto_retry_started', {}, { agentId: 'a1' }, 15));
    expect(line).not.toBeNull();
    expect(line as string).toContain('1/1');
  });

  it('sanitizes a multi-line errorMessage into a single line', () => {
    const line = formatWorkflowEventLine(
      ev(
        'auto_retry_started',
        { attempt: 1, maxAttempts: 3, delayMs: 100, errorMessage: 'line one\nline two' },
        { agentId: 'a1' },
        16,
      ),
    );
    expect(line).not.toBeNull();
    // Newline collapsed to a space; both fragments remain.
    expect(line as string).not.toContain('\n');
    expect(line as string).toContain('line one line two');
  });
});

// ── auto_retry_completed ─────────────────────────────────────────────────────

describe('formatWorkflowEventLine — auto_retry_completed', () => {
  it('renders a success line', () => {
    const line = formatWorkflowEventLine(
      ev('auto_retry_completed', { success: true, attempt: 2 }, { agentId: 'a1' }, 20),
    );
    expect(line).not.toBeNull();
    expect(line as string).toContain('succeeded');
  });

  it('renders a failure line with the finalError', () => {
    const line = formatWorkflowEventLine(
      ev('auto_retry_completed', { success: false, attempt: 3, finalError: 'timeout' }, { agentId: 'a1' }, 21),
    );
    expect(line).not.toBeNull();
    expect(line as string).toContain('failed');
    expect(line as string).toContain('timeout');
  });

  it('renders a failure line even when finalError is absent', () => {
    const line = formatWorkflowEventLine(
      ev('auto_retry_completed', { success: false, attempt: 3 }, { agentId: 'a1' }, 22),
    );
    expect(line).not.toBeNull();
    expect(line as string).toContain('failed');
    // Without a finalError the suffix is empty ("failed: " with empty value).
    expect(line as string).toContain('❌ retry failed: ');
  });

  it('treats a truthy-but-non-boolean success as NOT a success', () => {
    // success === true is the only success path; any other value is failure.
    const line = formatWorkflowEventLine(
      ev('auto_retry_completed', { success: 'true' as unknown as boolean, attempt: 1 }, { agentId: 'a1' }, 23),
    );
    expect(line).not.toBeNull();
    expect(line as string).toContain('failed');
  });

  it('sanitizes a multi-line finalError into a single line', () => {
    const line = formatWorkflowEventLine(
      ev('auto_retry_completed', { success: false, attempt: 1, finalError: 'a\nb' }, { agentId: 'a1' }, 24),
    );
    expect(line).not.toBeNull();
    expect(line as string).not.toContain('\n');
    expect(line as string).toContain('a b');
  });
});
