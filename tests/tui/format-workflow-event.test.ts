import type { EventRecord } from '@engin/shared/event-types';
import { formatWorkflowEventLine } from '@engin/shared/format-workflow-event';
import { describe, expect, it } from 'bun:test';

// ─── Export surface ─────────────────────────────────────────────────────────
//
// formatWorkflowEventLine's canonical home is @engin/shared/format-workflow-event.
// The shared package cannot resolve ./theme.js, so stripAnsi must exist as an
// inlined private helper — it must NOT be exported. No theme/TUI symbols should
// leak into the shared module.

// ─── Helpers ─────────────────────────────────────────────────────────────────

const TS = '2025-01-01T00:00:00Z';

/** Format an ISO timestamp as `HH:mm:ssam/pm` (local) — mirrors the formatter. */
function timePref(iso: string = TS): string {
  const d = new Date(iso);
  let h = d.getHours();
  const ampm = h < 12 ? 'am' : 'pm';
  h = h % 12;
  if (h === 0) h = 12;
  return `${String(h).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}${ampm}`;
}

/** Build a workflow-scope prefix: `<time> -> `. */
const wf = (iso: string = TS) => `${timePref(iso)} -> `;

function ev(
  type: EventRecord['type'],
  data: Record<string, unknown> = {},
  metadata: EventRecord['metadata'] = { timestamp: TS },
): EventRecord {
  return { seq: 1, type, data, metadata };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('formatWorkflowEventLine', () => {
  // ── Workflow lifecycle (no prefix slots) ─────────────────────────────────

  describe('workflow_started', () => {
    it('returns expected line with taskPrompt and resumed:false', () => {
      const line = formatWorkflowEventLine(ev('workflow_started', { taskPrompt: 'build feature', resumed: false }));
      expect(line).toBe(`${wf()}🚀 workflow started: "build feature" (resumed: false)`);
    });

    it('returns expected line with resumed:true', () => {
      const line = formatWorkflowEventLine(ev('workflow_started', { taskPrompt: 'continue work', resumed: true }));
      expect(line).toBe(`${wf()}🚀 workflow started: "continue work" (resumed: true)`);
    });

    it('defaults taskPrompt to empty string when missing', () => {
      const line = formatWorkflowEventLine(ev('workflow_started', {}));
      expect(line).toBe(`${wf()}🚀 workflow started: "" (resumed: false)`);
    });
  });

  describe('workflow_completed', () => {
    it('returns expected line with duration and agent count', () => {
      const line = formatWorkflowEventLine(ev('workflow_completed', { totalDurationMs: 3456, sessionCount: 5 }));
      expect(line).toBe(`${wf()}🎉 complete in 3.5s (5 sessions)`);
    });

    it('rounds to 1 decimal place', () => {
      const line = formatWorkflowEventLine(ev('workflow_completed', { totalDurationMs: 1234, sessionCount: 1 }));
      expect(line).toBe(`${wf()}🎉 complete in 1.2s (1 sessions)`);
    });

    it('defaults to 0s and 0 sessions when missing', () => {
      const line = formatWorkflowEventLine(ev('workflow_completed', {}));
      expect(line).toBe(`${wf()}🎉 complete in 0.0s (0 sessions)`);
    });
  });

  describe('workflow_failed', () => {
    it('returns expected line with phase (from data.phase) and error', () => {
      const line = formatWorkflowEventLine(ev('workflow_failed', { phase: 'planning', error: 'something broke' }));
      expect(line).toBe(`${timePref()} | planning -> 💥 failed: something broke`);
    });

    it('omits the phase slot when phase is missing', () => {
      const line = formatWorkflowEventLine(ev('workflow_failed', {}));
      expect(line).toBe(`${wf()}💥 failed: `);
    });
  });

  // ── Phase lifecycle (phase slot) ─────────────────────────────────────────

  describe('phase_registered', () => {
    it('returns expected line naming the phase from metadata.phaseId', () => {
      const line = formatWorkflowEventLine(
        ev(
          'phase_registered',
          { id: 'scouting', label: 'Scouting', icon: '🔍' },
          { timestamp: TS, phaseId: 'scouting' },
        ),
      );
      expect(line).toBe(`${timePref()} | scouting -> 📝 phase registered`);
    });

    it('omits the phase slot when phaseId is missing', () => {
      const line = formatWorkflowEventLine(ev('phase_registered', { label: 'Scouting' }));
      expect(line).toBe(`${wf()}📝 phase registered`);
    });
  });

  describe('phase_started', () => {
    it('returns expected line with phase and round', () => {
      const line = formatWorkflowEventLine(ev('phase_started', { phase: 'scouting', round: 2 }));
      expect(line).toBe(`${timePref()} | scouting -> 📦 phase started (round 2)`);
    });
  });

  describe('phase_completed', () => {
    it('returns expected line with phase and duration', () => {
      const line = formatWorkflowEventLine(ev('phase_completed', { phase: 'scouting', durationMs: 2500 }));
      expect(line).toBe(`${timePref()} | scouting -> ✅ phase completed (2.5s)`);
    });

    it('rounds to 1 decimal place', () => {
      const line = formatWorkflowEventLine(ev('phase_completed', { phase: 'plan', durationMs: 999 }));
      expect(line).toBe(`${timePref()} | plan -> ✅ phase completed (1.0s)`);
    });
  });

  // ── Session lifecycle (phase + task + session slots) ─────────────────────

  describe('session_started', () => {
    it('returns expected line with agentId (session slot) and profile', () => {
      const line = formatWorkflowEventLine(ev('session_started', { agentId: 'a1', profile: 'scout' }));
      expect(line).toBe(`${timePref()} | a1 -> ⏳ session started (scout)`);
    });

    it('falls back to metadata agentId when data.agentId is missing', () => {
      const line = formatWorkflowEventLine(
        ev('session_started', { profile: 'scout' }, { timestamp: TS, agentId: 'meta-a1' }),
      );
      expect(line).toBe(`${timePref()} | meta-a1 -> ⏳ session started (scout)`);
    });
  });

  describe('session_completed', () => {
    it('returns expected line with agentId from data', () => {
      const line = formatWorkflowEventLine(ev('session_completed', { agentId: 'a1' }));
      expect(line).toBe(`${timePref()} | a1 -> ✅ session complete`);
    });

    it('falls back to metadata agentId', () => {
      const line = formatWorkflowEventLine(ev('session_completed', {}, { timestamp: TS, agentId: 'meta-a1' }));
      expect(line).toBe(`${timePref()} | meta-a1 -> ✅ session complete`);
    });
  });

  describe('session_failed', () => {
    it('returns expected line with agentId and error', () => {
      const line = formatWorkflowEventLine(ev('session_failed', { agentId: 'a1', error: 'crashed' }));
      expect(line).toBe(`${timePref()} | a1 -> 💥 session failed: crashed`);
    });
  });

  // ── Task lifecycle (phase + task slots, no session slot) ─────────────────

  describe('task_registered', () => {
    it('returns expected line naming the task + phase', () => {
      const line = formatWorkflowEventLine(
        ev(
          'task_registered',
          { taskId: 't1', title: 'Implement feature', phaseId: 'p1', stepCount: 3 },
          { timestamp: TS, taskId: 't1', phaseId: 'p1' },
        ),
      );
      expect(line).toBe(`${timePref()} | p1 | t1 -> 📋 task registered: "Implement feature"`);
    });

    it('falls back to metadata phaseId when data.phaseId is missing', () => {
      const line = formatWorkflowEventLine(
        ev(
          'task_registered',
          { taskId: 't1', title: 'Task', stepCount: 2 },
          { timestamp: TS, taskId: 't1', phaseId: 'meta-p1' },
        ),
      );
      expect(line).toBe(`${timePref()} | meta-p1 | t1 -> 📋 task registered: "Task"`);
    });

    it('renders without phase/task slots when ids are missing', () => {
      const line = formatWorkflowEventLine(ev('task_registered', {}));
      expect(line).toBe(`${timePref()} -> 📋 task registered: ""`);
    });
  });

  describe('task_started', () => {
    it('returns expected line with taskId and title', () => {
      const line = formatWorkflowEventLine(
        ev('task_started', { taskId: 't1', title: 'Implement feature' }, { timestamp: TS, taskId: 't1' }),
      );
      expect(line).toBe(`${timePref()} | t1 -> 📋 task started: "Implement feature"`);
    });

    it('falls back to metadata taskId', () => {
      const line = formatWorkflowEventLine(
        ev('task_started', { title: 'Some task' }, { timestamp: TS, taskId: 'meta-t1' }),
      );
      expect(line).toBe(`${timePref()} | meta-t1 -> 📋 task started: "Some task"`);
    });

    it('strips ANSI CSI escape codes from title', () => {
      const ansiTitle = '\x1b[32mGreen Title\x1b[0m';
      const line = formatWorkflowEventLine(
        ev('task_started', { taskId: 't1', title: ansiTitle }, { timestamp: TS, taskId: 't1' }),
      );
      expect(line).toBe(`${timePref()} | t1 -> 📋 task started: "Green Title"`);
      expect(line).not.toContain('\x1b');
    });

    it('strips ANSI OSC sequences terminated by BEL (ESC ] ... \\x07)', () => {
      const line = formatWorkflowEventLine(
        ev('task_started', { taskId: 't1', title: '\x1b]0;t\x07T' }, { timestamp: TS, taskId: 't1' }),
      );
      expect(line).toBe(`${timePref()} | t1 -> 📋 task started: "T"`);
      expect(line).not.toContain('\x1b');
    });

    it('strips ANSI OSC sequences terminated by ST (ESC \\)', () => {
      const line = formatWorkflowEventLine(
        ev('task_started', { taskId: 't1', title: '\x1b]0;x\x1b\\T' }, { timestamp: TS, taskId: 't1' }),
      );
      expect(line).toBe(`${timePref()} | t1 -> 📋 task started: "T"`);
      expect(line).not.toContain('\x1b');
    });

    it('strips mixed CSI and OSC sequences in one string', () => {
      const line = formatWorkflowEventLine(
        ev('task_started', { taskId: 't1', title: '\x1b[31mR\x1b[0m\x1b]0;t\x07E' }, { timestamp: TS, taskId: 't1' }),
      );
      expect(line).toBe(`${timePref()} | t1 -> 📋 task started: "RE"`);
      expect(line).not.toContain('\x1b');
    });

    it('passes through plain strings without escape char unchanged (fast path)', () => {
      const line = formatWorkflowEventLine(
        ev('task_started', { taskId: 't1', title: 'plain title' }, { timestamp: TS, taskId: 't1' }),
      );
      expect(line).toBe(`${timePref()} | t1 -> 📋 task started: "plain title"`);
    });
  });

  describe('task_completed', () => {
    it('returns expected line with taskId', () => {
      const line = formatWorkflowEventLine(ev('task_completed', { taskId: 't1' }, { timestamp: TS, taskId: 't1' }));
      expect(line).toBe(`${timePref()} | t1 -> ✅ task complete`);
    });

    it('falls back to metadata taskId', () => {
      const line = formatWorkflowEventLine(ev('task_completed', {}, { timestamp: TS, taskId: 'meta-t1' }));
      expect(line).toBe(`${timePref()} | meta-t1 -> ✅ task complete`);
    });

    it('includes phaseId in the prefix when provided', () => {
      const line = formatWorkflowEventLine(
        ev('task_completed', { taskId: 't1' }, { timestamp: TS, taskId: 't1', phaseId: 'implementing' }),
      );
      expect(line).toBe(`${timePref()} | implementing | t1 -> ✅ task complete`);
    });
  });

  describe('task_rejected', () => {
    it('returns expected line with taskId and reason', () => {
      const line = formatWorkflowEventLine(
        ev('task_rejected', { taskId: 't1', reason: 'bad code' }, { timestamp: TS, taskId: 't1' }),
      );
      expect(line).toBe(`${timePref()} | t1 -> ❌ task rejected: bad code`);
    });
  });

  describe('task_parked / task_unparked', () => {
    it('formats task_parked with phase + task slots', () => {
      const line = formatWorkflowEventLine(
        ev(
          'task_parked',
          { taskId: 't10', title: 'Parked task' },
          { timestamp: TS, taskId: 't10', phaseId: 'implementing' },
        ),
      );
      expect(line).toBe(`${timePref()} | implementing | t10 -> 🅿 task parked`);
    });

    it('formats task_unparked with phase + task slots', () => {
      const line = formatWorkflowEventLine(
        ev(
          'task_unparked',
          { taskId: 't10', title: 'Parked task' },
          { timestamp: TS, taskId: 't10', phaseId: 'implementing' },
        ),
      );
      expect(line).toBe(`${timePref()} | implementing | t10 -> ▶ task unparked`);
    });
  });

  // ── Errors (phase + task + session slots) ────────────────────────────────

  describe('error', () => {
    it('returns expected line with phase, agentId (session slot), and error', () => {
      const line = formatWorkflowEventLine(
        ev('error', { error: 'crash' }, { timestamp: TS, agentId: 'a1', phaseId: 'planning' }),
      );
      expect(line).toBe(`${timePref()} | planning | a1 -> ⚠️ error: crash`);
    });

    it('strips ANSI escape codes from error message', () => {
      const ansiError = '\x1b[31mFATAL\x1b[0m: broken';
      const line = formatWorkflowEventLine(
        ev('error', { error: ansiError }, { timestamp: TS, agentId: 'a1', phaseId: 'p' }),
      );
      expect(line).toBe(`${timePref()} | p | a1 -> ⚠️ error: FATAL: broken`);
      expect(line).not.toContain('\x1b');
    });

    it('defaults to bare time prefix when metadata fields are missing', () => {
      const line = formatWorkflowEventLine(ev('error', {}, { timestamp: TS }));
      expect(line).toBe(`${wf()}⚠️ error: `);
    });
  });

  // ── Sidebar (no prefix slots) ────────────────────────────────────────────

  describe('sidebar_updated', () => {
    it('returns line with title when title is present', () => {
      const line = formatWorkflowEventLine(ev('sidebar_updated', { title: 'My Workflow' }));
      expect(line).toBe(`${wf()}📌 My Workflow`);
    });

    it('returns null when title is missing', () => {
      const line = formatWorkflowEventLine(ev('sidebar_updated', { indicator: '🟢' }));
      expect(line).toBeNull();
    });

    it('returns null when title is empty string', () => {
      const line = formatWorkflowEventLine(ev('sidebar_updated', { title: '' }));
      expect(line).toBeNull();
    });
  });

  // ── Verbose / silent types ───────────────────────────────────────────────

  describe('verbose events return null', () => {
    it('decision returns null', () => {
      expect(formatWorkflowEventLine(ev('decision', { decision: 'proceed', reasoning: 'looks good' }))).toBeNull();
    });

    it('turn_started returns null', () => {
      expect(formatWorkflowEventLine(ev('turn_started', { turn: 1 }))).toBeNull();
    });

    it('turn_ended returns null', () => {
      expect(
        formatWorkflowEventLine(ev('turn_ended', { turn: 1, contentBlocks: [{ type: 'text', text: 'output' }] })),
      ).toBeNull();
    });

    it('tool_call_started returns null', () => {
      expect(
        formatWorkflowEventLine(ev('tool_call_started', { toolName: 'read', toolCallId: 'tc1', arguments: {} })),
      ).toBeNull();
    });

    it('tool_call_ended returns null', () => {
      expect(
        formatWorkflowEventLine(ev('tool_call_ended', { toolName: 'read', toolCallId: 'tc1', isError: false })),
      ).toBeNull();
    });

    it('log returns null', () => {
      expect(formatWorkflowEventLine(ev('log', { content: 'some log line' }))).toBeNull();
    });
  });

  // ── Auto-retry lifecycle (session slot) ──────────────────────────────────

  describe('auto_retry_started', () => {
    it('returns full line with all populated fields', () => {
      const line = formatWorkflowEventLine(
        ev('auto_retry_started', { attempt: 2, maxAttempts: 5, delayMs: 3000, errorMessage: 'timeout' }),
      );
      expect(line).toBe(`${wf()}🔄 retrying (attempt 2/5) in 3s: timeout`);
    });

    it('omits the suffix when errorMessage is missing', () => {
      const line = formatWorkflowEventLine(ev('auto_retry_started', { attempt: 1, maxAttempts: 3, delayMs: 1000 }));
      expect(line).toBe(`${wf()}🔄 retrying (attempt 1/3) in 1s`);
    });

    it('omits the suffix when errorMessage is empty string', () => {
      const line = formatWorkflowEventLine(
        ev('auto_retry_started', { attempt: 1, maxAttempts: 2, delayMs: 500, errorMessage: '' }),
      );
      expect(line).toBe(`${wf()}🔄 retrying (attempt 1/2) in 500ms`);
    });

    it('defaults missing attempt/maxAttempts/delayMs defensively', () => {
      const line = formatWorkflowEventLine(ev('auto_retry_started', {}));
      expect(line).toBe(`${wf()}🔄 retrying (attempt 1/1)`);
    });

    it('strips ANSI escape codes from errorMessage in retry line', () => {
      const ansiMsg = '\x1b[31moverloaded\x1b[0m (429)';
      const line = formatWorkflowEventLine(
        ev('auto_retry_started', { attempt: 1, maxAttempts: 3, delayMs: 1000, errorMessage: ansiMsg }),
      );
      expect(line).toBe(`${wf()}🔄 retrying (attempt 1/3) in 1s: overloaded (429)`);
      expect(line).not.toContain('\x1b');
    });

    it('collapses newlines in errorMessage to a single line', () => {
      const multiLine = 'line1\nline2\r\nline3';
      const line = formatWorkflowEventLine(
        ev('auto_retry_started', { attempt: 1, maxAttempts: 3, delayMs: 500, errorMessage: multiLine }),
      );
      expect(line).toBe(`${wf()}🔄 retrying (attempt 1/3) in 500ms: line1 line2 line3`);
    });

    it('strips ANSI + collapses newlines together in errorMessage', () => {
      const messy = '\x1b[33mfirst\x1b[0m\n\x1b[34msecond\x1b[0m';
      const line = formatWorkflowEventLine(
        ev('auto_retry_started', { attempt: 2, maxAttempts: 4, delayMs: 2000, errorMessage: messy }),
      );
      expect(line).toBe(`${wf()}🔄 retrying (attempt 2/4) in 2s: first second`);
      expect(line).not.toContain('\x1b');
      expect(line).not.toContain('\n');
    });
  });

  describe('auto_retry_completed', () => {
    it('returns success line when success is true', () => {
      const line = formatWorkflowEventLine(ev('auto_retry_completed', { success: true }));
      expect(line).toBe(`${wf()}✅ retry succeeded`);
    });

    it('returns failure line with finalError when success is false', () => {
      const line = formatWorkflowEventLine(
        ev('auto_retry_completed', { success: false, finalError: 'connection refused' }),
      );
      expect(line).toBe(`${wf()}❌ retry failed: connection refused`);
    });

    it('handles missing finalError defensively when success is false', () => {
      const line = formatWorkflowEventLine(ev('auto_retry_completed', { success: false }));
      expect(line).toBe(`${wf()}❌ retry failed: `);
    });

    it('treats non-true success as failure', () => {
      const line = formatWorkflowEventLine(ev('auto_retry_completed', { success: 'yes', finalError: 'err' }));
      expect(line).toBe(`${wf()}❌ retry failed: err`);
    });

    it('strips ANSI escape codes from finalError in failure line', () => {
      const ansiError = '\x1b[31mConnection\x1b[0m refused';
      const line = formatWorkflowEventLine(ev('auto_retry_completed', { success: false, finalError: ansiError }));
      expect(line).toBe(`${wf()}❌ retry failed: Connection refused`);
      expect(line).not.toContain('\x1b');
    });

    it('collapses newlines in finalError to a single line', () => {
      const multiLine = 'line1\nline2\nline3';
      const line = formatWorkflowEventLine(ev('auto_retry_completed', { success: false, finalError: multiLine }));
      expect(line).toBe(`${wf()}❌ retry failed: line1 line2 line3`);
    });

    it('strips ANSI + collapses newlines together in finalError', () => {
      const messy = '\x1b[31mfirst line\x1b[0m\n\x1b[32msecond line\x1b[0m';
      const line = formatWorkflowEventLine(ev('auto_retry_completed', { success: false, finalError: messy }));
      expect(line).toBe(`${wf()}❌ retry failed: first line second line`);
      expect(line).not.toContain('\x1b');
      expect(line).not.toContain('\n');
    });
  });
});

describe('@engin/shared/format-workflow-event — export surface', () => {
  it('exports only formatWorkflowEventLine (stripAnsi is NOT exported)', async () => {
    const mod = (await import('@engin/shared/format-workflow-event')) as Record<string, unknown>;
    expect(mod.formatWorkflowEventLine).toBe(formatWorkflowEventLine);
    // stripAnsi must be inlined as a private helper, NOT re-exported.
    expect(mod.stripAnsi).toBeUndefined();
    // No theme/TUI symbols should leak into the shared package module.
    expect(mod.theme).toBeUndefined();
  });
});
