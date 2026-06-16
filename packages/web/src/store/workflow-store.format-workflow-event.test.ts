/**
 * Web migration verification: workflow-store uses @engin/shared/format-workflow-event.
 *
 * `web/src/store/workflow-store.ts` imports:
 *
 *   import { formatWorkflowEventLine } from '@engin/shared/format-workflow-event';
 *
 * (previously '@engin/tui/format-workflow-event'). The formatter is consumed
 * internally inside `applyEvents` and is not re-exported, so the migration is
 * verified behaviourally with a contract test: for every event fed into the
 * store, the workflowEventLog line produced must EXACTLY equal
 * `formatWorkflowEventLine(event)` from the shared package — and events for
 * which the shared formatter returns null must not appear in the log at all.
 *
 * This dynamically pins the store's dependency on the shared formatter: a
 * broken or wrong import (e.g. still pointing at an old shim that diverged)
 * would surface as a line mismatch here, rather than only as a hardcoded-string
 * assertion as in workflow-store.test.ts.
 */

import { beforeEach, describe, expect, it } from 'vitest';

// ── NEW canonical home: shared package ──────────────────────────────────────
import { formatWorkflowEventLine } from '@engin/shared/format-workflow-event';

// ── Store under test ────────────────────────────────────────────────────────
import type { EventRecord } from '../protocol-types';
import { useWorkflowStore } from './workflow-store';

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

function resetStore(): void {
  useWorkflowStore.setState({
    agentsById: {},
    tasksById: {},
    phases: [],
    currentPhaseId: '',
    completedPhaseIds: [],
    sidebar: { title: '', indicator: '' },
    status: 'running',
    taskPrompt: '',
    error: undefined,
    failedPhase: undefined,
    seq: 0,
    stats: { totalTokens: 0, agentCount: 0 },
    workflowEventLog: [],
    selectedPhaseId: null,
    selectedTaskId: null,
    selectedStepIndex: null,
    userPinnedPhase: false,
    userPinnedStep: false,
    runs: [],
    selectedRunId: 'run-1',
    runLogs: {},
  });
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('workflow-store — event log lines match @engin/shared/format-workflow-event', () => {
  beforeEach(resetStore);

  it('produces a line equal to formatWorkflowEventLine for each loud lifecycle event', () => {
    const events: EventRecord[] = [
      ev('workflow_started', { taskPrompt: 'ship it', resumed: false }, {}, 1),
      ev('phase_registered', { id: 'p1', label: 'Build', icon: '🔧' }, {}, 2),
      ev('phase_started', { phase: 'p1', round: 1 }, {}, 3),
      ev('task_registered', { id: 't1', title: 'Task 1', phaseId: 'p1', stepCount: 1 }, { phaseId: 'p1' }, 4),
      ev('task_started', { taskId: 't1', title: 'Task 1' }, {}, 5),
      ev('agent_spawned', { profile: 'coder' }, { agentId: 'a1', taskId: 't1' }, 6),
      ev('task_completed', { taskId: 't1' }, {}, 7),
      ev('phase_completed', { phase: 'p1', durationMs: 2500 }, {}, 8),
      ev('workflow_completed', { totalDurationMs: 5000, agentCount: 1 }, {}, 9),
    ];

    useWorkflowStore.getState().applyEvents('run-1', events);

    const log = useWorkflowStore.getState().workflowEventLog;

    // Every event in this set is "loud" — the shared formatter returns a line.
    const expected = events
      .map((event) => ({ seq: event.seq, line: formatWorkflowEventLine(event) }))
      .filter((e): e is { seq: number; line: string } => e.line !== null);

    expect(log).toEqual(expected);
  });

  it('excludes events for which formatWorkflowEventLine returns null (verbose events)', () => {
    const events: EventRecord[] = [
      ev('workflow_started', { taskPrompt: 'x' }, {}, 1),
      ev('agent_spawned', { profile: 'p' }, { agentId: 'a1', taskId: 't1' }, 2),
      ev('decision', { decision: 'proceed' }, { agentId: 'a1' }, 3),
      ev('tool_call_started', { toolName: 'read' }, { agentId: 'a1' }, 4),
      ev('turn_ended', { tokens: { input: 1, output: 1 } }, { agentId: 'a1' }, 5),
    ];

    useWorkflowStore.getState().applyEvents('run-1', events);

    const log = useWorkflowStore.getState().workflowEventLog;

    // decision / tool_call_started / turn_ended are silent — only the first two
    // events produce lines.
    expect(log).toHaveLength(2);
    for (const event of events) {
      const sharedLine = formatWorkflowEventLine(event);
      if (sharedLine === null) {
        expect(log.find((entry) => entry.seq === event.seq)).toBeUndefined();
      } else {
        expect(log.find((entry) => entry.seq === event.seq)).toEqual({ seq: event.seq, line: sharedLine });
      }
    }
  });

  it('preserves the seq key on each log entry (matches the shared formatter call site)', () => {
    useWorkflowStore.getState().applyEvents('run-1', [ev('workflow_started', { taskPrompt: 'seq-check' }, {}, 77)]);
    const log = useWorkflowStore.getState().workflowEventLog;
    expect(log[0].seq).toBe(77);
    expect(log[0].line).toBe(formatWorkflowEventLine(ev('workflow_started', { taskPrompt: 'seq-check' }, {}, 77)));
  });
});
