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

function ev(
  type: EventRecord['type'],
  data: Record<string, unknown> = {},
  metadata: EventRecord['metadata'] = { timestamp: '2025-01-01T00:00:00Z' },
): EventRecord {
  return { seq: 1, type, data, metadata };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('formatWorkflowEventLine', () => {
  // ── Workflow lifecycle ───────────────────────────────────────────────────

  describe('workflow_started', () => {
    it('returns expected line with taskPrompt and resumed:false', () => {
      const line = formatWorkflowEventLine(ev('workflow_started', { taskPrompt: 'build feature', resumed: false }));
      expect(line).toBe('🚀 Workflow started: "build feature" (resumed: false)');
    });

    it('returns expected line with resumed:true', () => {
      const line = formatWorkflowEventLine(ev('workflow_started', { taskPrompt: 'continue work', resumed: true }));
      expect(line).toBe('🚀 Workflow started: "continue work" (resumed: true)');
    });

    it('defaults taskPrompt to empty string when missing', () => {
      const line = formatWorkflowEventLine(ev('workflow_started', {}));
      expect(line).toBe('🚀 Workflow started: "" (resumed: false)');
    });
  });

  describe('workflow_completed', () => {
    it('returns expected line with duration and agent count', () => {
      const line = formatWorkflowEventLine(ev('workflow_completed', { totalDurationMs: 3456, agentCount: 5 }));
      expect(line).toBe('🎉 Complete in 3.5s (5 agents)');
    });

    it('rounds to 1 decimal place', () => {
      const line = formatWorkflowEventLine(ev('workflow_completed', { totalDurationMs: 1234, agentCount: 1 }));
      expect(line).toBe('🎉 Complete in 1.2s (1 agents)');
    });

    it('defaults to 0s and 0 agents when missing', () => {
      const line = formatWorkflowEventLine(ev('workflow_completed', {}));
      expect(line).toBe('🎉 Complete in 0.0s (0 agents)');
    });
  });

  describe('workflow_failed', () => {
    it('returns expected line with phase and error', () => {
      const line = formatWorkflowEventLine(ev('workflow_failed', { phase: 'planning', error: 'something broke' }));
      expect(line).toBe('💥 Failed at planning: something broke');
    });

    it('defaults to empty strings when missing', () => {
      const line = formatWorkflowEventLine(ev('workflow_failed', {}));
      expect(line).toBe('💥 Failed at : ');
    });
  });

  // ── Phase lifecycle ──────────────────────────────────────────────────────

  describe('phase_registered', () => {
    it('returns expected line with label', () => {
      const line = formatWorkflowEventLine(ev('phase_registered', { label: 'Scouting' }));
      expect(line).toBe('📝 Phase registered: Scouting');
    });

    it('defaults label to empty string when missing', () => {
      const line = formatWorkflowEventLine(ev('phase_registered', {}));
      expect(line).toBe('📝 Phase registered: ');
    });
  });

  describe('phase_started', () => {
    it('returns expected line with phase and round', () => {
      const line = formatWorkflowEventLine(ev('phase_started', { phase: 'scouting', round: 2 }));
      expect(line).toBe('📦 Phase: scouting (round 2)');
    });
  });

  describe('phase_completed', () => {
    it('returns expected line with phase and duration', () => {
      const line = formatWorkflowEventLine(ev('phase_completed', { phase: 'scouting', durationMs: 2500 }));
      expect(line).toBe('✅ Phase scouting done (2.5s)');
    });

    it('rounds to 1 decimal place', () => {
      const line = formatWorkflowEventLine(ev('phase_completed', { phase: 'plan', durationMs: 999 }));
      expect(line).toBe('✅ Phase plan done (1.0s)');
    });
  });

  // ── Agent lifecycle ──────────────────────────────────────────────────────

  describe('agent_spawned', () => {
    it('returns expected line with agentId and profile from data', () => {
      const line = formatWorkflowEventLine(ev('agent_spawned', { agentId: 'a1', profile: 'scout' }));
      expect(line).toBe('⏳ Agent a1 spawned (scout)');
    });

    it('falls back to metadata agentId when data.agentId is missing', () => {
      const line = formatWorkflowEventLine(
        ev('agent_spawned', { profile: 'scout' }, { timestamp: '2025-01-01T00:00:00Z', agentId: 'meta-a1' }),
      );
      expect(line).toBe('⏳ Agent meta-a1 spawned (scout)');
    });
  });

  describe('agent_completed', () => {
    it('returns expected line with agentId from data', () => {
      const line = formatWorkflowEventLine(ev('agent_completed', { agentId: 'a1' }));
      expect(line).toBe('✅ Agent a1 complete');
    });

    it('falls back to metadata agentId', () => {
      const line = formatWorkflowEventLine(
        ev('agent_completed', {}, { timestamp: '2025-01-01T00:00:00Z', agentId: 'meta-a1' }),
      );
      expect(line).toBe('✅ Agent meta-a1 complete');
    });
  });

  // ── Task lifecycle ───────────────────────────────────────────────────────

  describe('task_registered', () => {
    it('returns expected line with title, phaseId from data, and step count', () => {
      const line = formatWorkflowEventLine(
        ev('task_registered', { title: 'Implement feature', phaseId: 'p1', stepCount: 3 }),
      );
      expect(line).toBe('📋 Task registered: "Implement feature" (phase: p1, 3 steps)');
    });

    it('falls back to metadata phaseId when data.phaseId is missing', () => {
      const line = formatWorkflowEventLine(
        ev(
          'task_registered',
          { title: 'Task', stepCount: 2 },
          { timestamp: '2025-01-01T00:00:00Z', phaseId: 'meta-p1' },
        ),
      );
      expect(line).toBe('📋 Task registered: "Task" (phase: meta-p1, 2 steps)');
    });

    it('defaults missing fields to empty string and 0', () => {
      const line = formatWorkflowEventLine(ev('task_registered', {}));
      expect(line).toBe('📋 Task registered: "" (phase: , 0 steps)');
    });
  });

  describe('task_started', () => {
    it('returns expected line with taskId and title', () => {
      const line = formatWorkflowEventLine(ev('task_started', { taskId: 't1', title: 'Implement feature' }));
      expect(line).toBe('📋 Task t1: "Implement feature"');
    });

    it('falls back to metadata taskId', () => {
      const line = formatWorkflowEventLine(
        ev('task_started', { title: 'Some task' }, { timestamp: '2025-01-01T00:00:00Z', taskId: 'meta-t1' }),
      );
      expect(line).toBe('📋 Task meta-t1: "Some task"');
    });

    it('strips ANSI CSI escape codes from title', () => {
      const ansiTitle = '\x1b[32mGreen Title\x1b[0m';
      const line = formatWorkflowEventLine(ev('task_started', { taskId: 't1', title: ansiTitle }));
      expect(line).toBe('📋 Task t1: "Green Title"');
      expect(line).not.toContain('\x1b');
    });

    it('strips ANSI OSC sequences terminated by BEL (ESC ] ... \\x07)', () => {
      // ESC ] 0 ; title \u0007
      const line = formatWorkflowEventLine(ev('task_started', { taskId: 't1', title: '\x1b]0;t\x07T' }));
      expect(line).toBe('📋 Task t1: "T"');
      expect(line).not.toContain('\x1b');
    });

    it('strips ANSI OSC sequences terminated by ST (ESC \\)', () => {
      // ESC ] 0 ; x ESC \\
      const line = formatWorkflowEventLine(ev('task_started', { taskId: 't1', title: '\x1b]0;x\x1b\\T' }));
      expect(line).toBe('📋 Task t1: "T"');
      expect(line).not.toContain('\x1b');
    });

    it('strips mixed CSI and OSC sequences in one string', () => {
      const line = formatWorkflowEventLine(
        ev('task_started', { taskId: 't1', title: '\x1b[31mR\x1b[0m\x1b]0;t\x07E' }),
      );
      expect(line).toBe('📋 Task t1: "RE"');
      expect(line).not.toContain('\x1b');
    });

    it('passes through plain strings without escape char unchanged (fast path)', () => {
      const line = formatWorkflowEventLine(ev('task_started', { taskId: 't1', title: 'plain title' }));
      expect(line).toBe('📋 Task t1: "plain title"');
    });
  });

  describe('task_completed', () => {
    it('returns expected line with taskId', () => {
      const line = formatWorkflowEventLine(ev('task_completed', { taskId: 't1' }));
      expect(line).toBe('✅ Task t1 complete');
    });

    it('falls back to metadata taskId', () => {
      const line = formatWorkflowEventLine(
        ev('task_completed', {}, { timestamp: '2025-01-01T00:00:00Z', taskId: 'meta-t1' }),
      );
      expect(line).toBe('✅ Task meta-t1 complete');
    });
  });

  describe('task_rejected', () => {
    it('returns expected line with taskId and reason', () => {
      const line = formatWorkflowEventLine(ev('task_rejected', { taskId: 't1', reason: 'bad code' }));
      expect(line).toBe('❌ Task t1 rejected: bad code');
    });
  });

  // ── Errors ───────────────────────────────────────────────────────────────

  describe('error', () => {
    it('returns expected line with agentId from metadata, error from data, phase from metadata', () => {
      const line = formatWorkflowEventLine(
        ev('error', { error: 'crash' }, { timestamp: '2025-01-01T00:00:00Z', agentId: 'a1', phaseId: 'planning' }),
      );
      expect(line).toBe('⚠️ Error in a1: crash (planning)');
    });

    it('strips ANSI escape codes from error message', () => {
      const ansiError = '\x1b[31mFATAL\x1b[0m: broken';
      const line = formatWorkflowEventLine(
        ev('error', { error: ansiError }, { timestamp: '2025-01-01T00:00:00Z', agentId: 'a1', phaseId: 'p' }),
      );
      expect(line).toBe('⚠️ Error in a1: FATAL: broken (p)');
      expect(line).not.toContain('\x1b');
    });

    it('defaults to empty strings when metadata fields are missing', () => {
      const line = formatWorkflowEventLine(ev('error', {}, { timestamp: '2025-01-01T00:00:00Z' }));
      expect(line).toBe('⚠️ Error in :  ()');
    });
  });

  // ── Sidebar ──────────────────────────────────────────────────────────────

  describe('sidebar_updated', () => {
    it('returns line with title when title is present', () => {
      const line = formatWorkflowEventLine(ev('sidebar_updated', { title: 'My Workflow' }));
      expect(line).toBe('📌 My Workflow');
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

  // ── Auto-retry lifecycle ────────────────────────────────────────────────

  describe('auto_retry_started', () => {
    it('returns full line with all populated fields', () => {
      const line = formatWorkflowEventLine(
        ev('auto_retry_started', { attempt: 2, maxAttempts: 5, delayMs: 3000, errorMessage: 'timeout' }),
      );
      expect(line).toBe('🔄 Retrying (attempt 2/5) in 3s: timeout');
    });

    it('omits the suffix when errorMessage is missing', () => {
      const line = formatWorkflowEventLine(ev('auto_retry_started', { attempt: 1, maxAttempts: 3, delayMs: 1000 }));
      expect(line).toBe('🔄 Retrying (attempt 1/3) in 1s');
    });

    it('omits the suffix when errorMessage is empty string', () => {
      const line = formatWorkflowEventLine(
        ev('auto_retry_started', { attempt: 1, maxAttempts: 2, delayMs: 500, errorMessage: '' }),
      );
      expect(line).toBe('🔄 Retrying (attempt 1/2) in 500ms');
    });

    it('defaults missing attempt/maxAttempts/delayMs defensively', () => {
      const line = formatWorkflowEventLine(ev('auto_retry_started', {}));
      expect(line).toBe('🔄 Retrying (attempt 1/1)');
    });

    it('strips ANSI escape codes from errorMessage in retry line', () => {
      const ansiMsg = '\x1b[31moverloaded\x1b[0m (429)';
      const line = formatWorkflowEventLine(
        ev('auto_retry_started', { attempt: 1, maxAttempts: 3, delayMs: 1000, errorMessage: ansiMsg }),
      );
      expect(line).toBe('🔄 Retrying (attempt 1/3) in 1s: overloaded (429)');
      expect(line).not.toContain('\x1b');
    });

    it('collapses newlines in errorMessage to a single line', () => {
      const multiLine = 'line1\nline2\r\nline3';
      const line = formatWorkflowEventLine(
        ev('auto_retry_started', { attempt: 1, maxAttempts: 3, delayMs: 500, errorMessage: multiLine }),
      );
      expect(line).toBe('🔄 Retrying (attempt 1/3) in 500ms: line1 line2 line3');
    });

    it('strips ANSI + collapses newlines together in errorMessage', () => {
      const messy = '\x1b[33mfirst\x1b[0m\n\x1b[34msecond\x1b[0m';
      const line = formatWorkflowEventLine(
        ev('auto_retry_started', { attempt: 2, maxAttempts: 4, delayMs: 2000, errorMessage: messy }),
      );
      expect(line).toBe('🔄 Retrying (attempt 2/4) in 2s: first second');
      expect(line).not.toContain('\x1b');
      expect(line).not.toContain('\n');
    });
  });

  describe('auto_retry_completed', () => {
    it('returns success line when success is true', () => {
      const line = formatWorkflowEventLine(ev('auto_retry_completed', { success: true }));
      expect(line).toBe('✅ Retry succeeded');
    });

    it('returns failure line with finalError when success is false', () => {
      const line = formatWorkflowEventLine(
        ev('auto_retry_completed', { success: false, finalError: 'connection refused' }),
      );
      expect(line).toBe('❌ Retry failed: connection refused');
    });

    it('handles missing finalError defensively when success is false', () => {
      const line = formatWorkflowEventLine(ev('auto_retry_completed', { success: false }));
      expect(line).toBe('❌ Retry failed: ');
    });

    it('treats non-true success as failure', () => {
      const line = formatWorkflowEventLine(ev('auto_retry_completed', { success: 'yes', finalError: 'err' }));
      expect(line).toBe('❌ Retry failed: err');
    });

    it('strips ANSI escape codes from finalError in failure line', () => {
      const ansiError = '\x1b[31mConnection\x1b[0m refused';
      const line = formatWorkflowEventLine(ev('auto_retry_completed', { success: false, finalError: ansiError }));
      expect(line).toBe('❌ Retry failed: Connection refused');
      expect(line).not.toContain('\x1b');
    });

    it('collapses newlines in finalError to a single line', () => {
      const multiLine = 'line1\nline2\nline3';
      const line = formatWorkflowEventLine(ev('auto_retry_completed', { success: false, finalError: multiLine }));
      expect(line).toBe('❌ Retry failed: line1 line2 line3');
    });

    it('strips ANSI + collapses newlines together in finalError', () => {
      const messy = '\x1b[31mfirst line\x1b[0m\n\x1b[32msecond line\x1b[0m';
      const line = formatWorkflowEventLine(ev('auto_retry_completed', { success: false, finalError: messy }));
      expect(line).toBe('❌ Retry failed: first line second line');
      expect(line).not.toContain('\x1b');
      expect(line).not.toContain('\n');
    });
  });

  // ── Step lifecycle ──────────────────────────────────────────────────────

  describe('step_started', () => {
    it('returns step name with task and agent', () => {
      const line = formatWorkflowEventLine(
        ev('step_started', { stepIndex: 1, stepName: 'review', taskId: 't1', agentId: 'a1' }),
      );
      expect(line).toBe('Step 1 started: review (task: t1, agent: a1)');
    });

    it('falls back to metadata taskId and agentId', () => {
      const line = formatWorkflowEventLine(
        ev(
          'step_started',
          { stepIndex: 2, stepName: 'build' },
          { timestamp: '2025-01-01T00:00:00Z', taskId: 'meta-t1', agentId: 'meta-a1', stepIndex: 2 },
        ),
      );
      expect(line).toBe('Step 2 started: build (task: meta-t1, agent: meta-a1)');
    });

    it('falls back to metadata stepIndex when data.stepIndex is missing', () => {
      const line = formatWorkflowEventLine(
        ev(
          'step_started',
          { stepName: 'test' },
          { timestamp: '2025-01-01T00:00:00Z', taskId: 't1', agentId: 'a1', stepIndex: 3 },
        ),
      );
      expect(line).toBe('Step 3 started: test (task: t1, agent: a1)');
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
