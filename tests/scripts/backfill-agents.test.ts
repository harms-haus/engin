/**
 * Tests for `reconstructAgents` from scripts/backfill-agents.ts
 *
 * TDD — these tests describe the desired behavior AFTER the fix:
 * - reconstructAgents should also infer non-implementing agents from
 *   `structured_output` and `decision` audit events
 * - Known agentId → phase mapping:
 *     "scout-coordinator" / "scout-*" → "scouting"
 *     "scouting-reviewer"              → "scouting_review"
 *     "planner"                        → "planning"
 *     "plan-reviewer"                  → "plan_review"
 *     "final-reviewer"                 → "final_review"
 *     "title-generator"                → "initialization"
 *
 * The function is currently not exported. The implementation step will:
 *   1. Export `reconstructAgents` from the script
 *   2. Guard `main()` with `if (import.meta.main)`
 *   3. Add inference from structured_output / decision events
 */

import { describe, expect, it } from 'bun:test';

// ── Import the function under test ──────────────────────────────────────
// After the implementation, this import will resolve. For now it fails
// because (a) reconstructAgents is not exported and (b) the script's
// top-level main() runs on import — both are expected TDD failures.
import { reconstructAgents } from '../../scripts/backfill-agents.js';

// ── Shared type helpers (mirrors script-internal types) ─────────────────

interface AuditEvent {
  type: string;
  agentId: string;
  profile?: { id: string; name?: string } | string;
  taskId?: string;
  phase?: string;
  stepIndex?: number;
  timestamp?: string;
  output?: unknown;
  decision?: string;
  reasoning?: string;
  [key: string]: unknown;
}

interface _PersistedAgentRecord {
  agentId: string;
  profile: string;
  phase: string;
  taskId?: string;
  completedAt?: string;
}

// ── Factories ───────────────────────────────────────────────────────────

function agentStart(
  agentId: string,
  overrides: Partial<{
    profile: { id: string; name?: string } | string;
    taskId: string;
    phase: string;
    stepIndex: number;
    timestamp: string;
  }> = {},
): AuditEvent {
  return {
    type: 'agent_start',
    agentId,
    profile: overrides.profile ?? 'default',
    taskId: overrides.taskId,
    phase: overrides.phase,
    stepIndex: overrides.stepIndex,
    timestamp: overrides.timestamp ?? '2025-01-15T10:00:00.000Z',
  };
}

function agentEnd(
  agentId: string,
  overrides: Partial<{ taskId: string; stepIndex: number; timestamp: string }> = {},
): AuditEvent {
  return {
    type: 'agent_end',
    agentId,
    taskId: overrides.taskId,
    stepIndex: overrides.stepIndex,
    timestamp: overrides.timestamp ?? '2025-01-15T10:05:00.000Z',
  };
}

function structuredOutput(
  agentId: string,
  output: unknown = {},
  overrides: Partial<{ taskId: string; timestamp: string }> = {},
): AuditEvent {
  return {
    type: 'structured_output',
    agentId,
    output,
    taskId: overrides.taskId,
    timestamp: overrides.timestamp ?? '2025-01-15T10:01:00.000Z',
  };
}

function decision(
  agentId: string,
  decisionText: string,
  reasoning: string,
  overrides: Partial<{ taskId: string; timestamp: string }> = {},
): AuditEvent {
  return {
    type: 'decision',
    agentId,
    decision: decisionText,
    reasoning,
    taskId: overrides.taskId,
    timestamp: overrides.timestamp ?? '2025-01-15T10:02:00.000Z',
  };
}

// ── Tests ───────────────────────────────────────────────────────────────

describe('reconstructAgents', () => {
  // ── 1. Basic existing behavior ──────────────────────────────────────

  it('reconstructs agents from agent_start events', () => {
    const events: AuditEvent[] = [
      agentStart('lane-0', { profile: 'coder', phase: 'implementing', taskId: 'task-1' }),
      agentEnd('lane-0', { taskId: 'task-1', timestamp: '2025-01-15T10:10:00.000Z' }),
      agentStart('lane-1', { profile: 'coder', phase: 'implementing', taskId: 'task-2' }),
    ];

    const result = reconstructAgents(events);

    expect(result).toHaveLength(2);
    expect(result[0].agentId).toBe('lane-0');
    expect(result[0].profile).toBe('coder');
    expect(result[0].phase).toBe('implementing');
    expect(result[0].taskId).toBe('task-1');
    expect(result[0].completedAt).toBe('2025-01-15T10:10:00.000Z');

    expect(result[1].agentId).toBe('lane-1');
    expect(result[1].taskId).toBe('task-2');
    expect(result[1].completedAt).toBeUndefined();
  });

  // ── 2. Defaults phase to implementing ───────────────────────────────

  it('defaults phase to implementing when not in event', () => {
    const events: AuditEvent[] = [agentStart('lane-0', { profile: 'coder', taskId: 'task-1' })];

    const result = reconstructAgents(events);

    expect(result).toHaveLength(1);
    expect(result[0].phase).toBe('implementing');
  });

  // ── 3. Infer non-implementing agents from structured_output ────────

  it('infers non-implementing agents from structured_output events', () => {
    const events: AuditEvent[] = [
      // No agent_start events — these agents were never recorded via agent_start
      structuredOutput('scout-coordinator', { reports: [] }),
      structuredOutput('scouting-reviewer', { approved: true }),
      structuredOutput('planner', { tasks: [] }),
      structuredOutput('plan-reviewer', { approved: true }),
      structuredOutput('final-reviewer', { approved: true }),
      structuredOutput('title-generator', { title: 'My Project' }),
    ];

    const result = reconstructAgents(events);

    expect(result).toHaveLength(6);

    const byId = Object.fromEntries(result.map((r) => [r.agentId, r]));

    expect(byId['scout-coordinator']).toBeDefined();
    expect(byId['scout-coordinator'].phase).toBe('scouting');

    expect(byId['scouting-reviewer']).toBeDefined();
    expect(byId['scouting-reviewer'].phase).toBe('scouting_review');

    expect(byId['planner']).toBeDefined();
    expect(byId['planner'].phase).toBe('planning');

    expect(byId['plan-reviewer']).toBeDefined();
    expect(byId['plan-reviewer'].phase).toBe('plan_review');

    expect(byId['final-reviewer']).toBeDefined();
    expect(byId['final-reviewer'].phase).toBe('final_review');

    expect(byId['title-generator']).toBeDefined();
    expect(byId['title-generator'].phase).toBe('initialization');
  });

  // ── 4. Infer agents from decision events ────────────────────────────

  it('infers agents from decision events', () => {
    const events: AuditEvent[] = [
      decision('scout-coordinator', 'proceed', 'Found good candidates'),
      decision('planner', 'approved', 'Plan looks solid'),
    ];

    const result = reconstructAgents(events);

    expect(result).toHaveLength(2);

    const byId = Object.fromEntries(result.map((r) => [r.agentId, r]));

    expect(byId['scout-coordinator']).toBeDefined();
    expect(byId['scout-coordinator'].phase).toBe('scouting');

    expect(byId['planner']).toBeDefined();
    expect(byId['planner'].phase).toBe('planning');
  });

  // ── 5. agent_start takes priority over inferred ─────────────────────

  it('agent_start records take priority over inferred ones', () => {
    const events: AuditEvent[] = [
      // agent_start explicitly records this agent with a custom phase
      agentStart('scout-coordinator', { profile: 'scout-profile', phase: 'custom-phase' }),
      // structured_output with same agentId would infer phase='scouting', but should NOT override
      structuredOutput('scout-coordinator', { reports: [] }),
    ];

    const result = reconstructAgents(events);

    // Should have exactly one record for scout-coordinator
    const scout = result.filter((r) => r.agentId === 'scout-coordinator');
    expect(scout).toHaveLength(1);

    // Phase must stay as 'custom-phase' from agent_start, NOT 'scouting' from inference
    expect(scout[0].phase).toBe('custom-phase');
    expect(scout[0].profile).toBe('scout-profile');
  });

  // ── 6. Unknown agentIds from structured_output are not added ────────

  it('unknown agentIds from structured_output are not added', () => {
    const events: AuditEvent[] = [
      structuredOutput('random-agent-xyz', { data: 42 }),
      structuredOutput('lane-99', { data: 99 }),
    ];

    const result = reconstructAgents(events);

    // Neither agent is in the known-agentId mapping, so no records
    expect(result).toHaveLength(0);
  });

  // ── 7. TaskId-based composite keys ──────────────────────────────────

  it('handles taskId-based composite keys', () => {
    const events: AuditEvent[] = [
      agentStart('lane-0', { profile: 'coder', taskId: 'task-1' }),
      agentStart('lane-0', { profile: 'coder', taskId: 'task-2' }),
      agentEnd('lane-0', { taskId: 'task-1', timestamp: '2025-01-15T10:10:00.000Z' }),
      agentEnd('lane-0', { taskId: 'task-2', timestamp: '2025-01-15T10:20:00.000Z' }),
    ];

    const result = reconstructAgents(events);

    expect(result).toHaveLength(2);

    const task1 = result.find((r) => r.taskId === 'task-1');
    const task2 = result.find((r) => r.taskId === 'task-2');

    expect(task1).toBeDefined();
    expect(task1!.agentId).toBe('lane-0');
    expect(task1!.completedAt).toBe('2025-01-15T10:10:00.000Z');

    expect(task2).toBeDefined();
    expect(task2!.agentId).toBe('lane-0');
    expect(task2!.completedAt).toBe('2025-01-15T10:20:00.000Z');
  });

  // ── 8. stepIndex-based composite keys ──────────────────────────────

  it('separates records by stepIndex within same agentId+taskId', () => {
    const events: AuditEvent[] = [
      agentStart('lane-0', { profile: 'coder', taskId: 'task-1', stepIndex: 0 }),
      agentStart('lane-0', { profile: 'coder', taskId: 'task-1', stepIndex: 1 }),
      agentEnd('lane-0', { taskId: 'task-1', stepIndex: 0, timestamp: '2025-01-15T10:10:00.000Z' }),
      agentEnd('lane-0', { taskId: 'task-1', stepIndex: 1, timestamp: '2025-01-15T10:20:00.000Z' }),
    ];

    const result = reconstructAgents(events);

    expect(result).toHaveLength(2);

    const step0 = result.find(
      (r) => r.agentId === 'lane-0' && r.taskId === 'task-1' && r.completedAt === '2025-01-15T10:10:00.000Z',
    );
    const step1 = result.find(
      (r) => r.agentId === 'lane-0' && r.taskId === 'task-1' && r.completedAt === '2025-01-15T10:20:00.000Z',
    );

    expect(step0).toBeDefined();
    expect(step0!.profile).toBe('coder');

    expect(step1).toBeDefined();
    expect(step1!.profile).toBe('coder');
  });

  // ── 9. agent_end matches correct stepIndex composite key ────────────

  it('agent_end with stepIndex only matches the start event with same stepIndex', () => {
    const events: AuditEvent[] = [
      agentStart('lane-0', { profile: 'coder', taskId: 'task-1', stepIndex: 0 }),
      agentStart('lane-0', { profile: 'tester', taskId: 'task-1', stepIndex: 1 }),
      // End event for stepIndex 0 and 1
      agentEnd('lane-0', { taskId: 'task-1', stepIndex: 0, timestamp: '2025-01-15T10:10:00.000Z' }),
    ];

    const result = reconstructAgents(events);

    expect(result).toHaveLength(2);

    // Find the record whose completedAt matches the end event
    const completed = result.find((r) => r.completedAt !== undefined);
    expect(completed).toBeDefined();
    expect(completed!.completedAt).toBe('2025-01-15T10:10:00.000Z');
    // The completed one should have profile 'coder' (from stepIndex 0)
    expect(completed!.profile).toBe('coder');

    // The other record (stepIndex 1) should have no completedAt
    const uncompleted = result.find((r) => r.completedAt === undefined);
    expect(uncompleted).toBeDefined();
    expect(uncompleted!.profile).toBe('tester');
  });

  // ── 10. Backward compatibility: stepIndex absent (old audit logs) ──

  it('backward compatible when stepIndex is absent (old audit logs)', () => {
    const events: AuditEvent[] = [
      agentStart('lane-0', { profile: 'coder', taskId: 'task-1' }),
      agentEnd('lane-0', { taskId: 'task-1', timestamp: '2025-01-15T10:10:00.000Z' }),
    ];

    const result = reconstructAgents(events);

    expect(result).toHaveLength(1);
    expect(result[0].agentId).toBe('lane-0');
    expect(result[0].taskId).toBe('task-1');
    expect(result[0].completedAt).toBe('2025-01-15T10:10:00.000Z');
  });

  // ── 11. isInferredScoutAgent path: scout-N agents ──────────────────

  it('infers scout-N agents from structured_output events', () => {
    const events: AuditEvent[] = [
      structuredOutput('scout-1', { results: [] }),
      structuredOutput('scout-2', { results: [] }),
    ];

    const result = reconstructAgents(events);

    expect(result).toHaveLength(2);

    const scout1 = result.find((r) => r.agentId === 'scout-1');
    const scout2 = result.find((r) => r.agentId === 'scout-2');

    expect(scout1).toBeDefined();
    expect(scout1!.phase).toBe('scouting');
    expect(scout1!.profile).toBe('');

    expect(scout2).toBeDefined();
    expect(scout2!.phase).toBe('scouting');
    expect(scout2!.profile).toBe('');
  });

  it('infers scout-N agents from decision events', () => {
    const events: AuditEvent[] = [decision('scout-1', 'proceed', 'Good candidates found')];

    const result = reconstructAgents(events);

    expect(result).toHaveLength(1);
    expect(result[0].agentId).toBe('scout-1');
    expect(result[0].phase).toBe('scouting');
  });

  // ── 12. agent_end for agent that never started creates minimal record ──

  it('creates minimal record for agent_end when no matching start event exists', () => {
    const events: AuditEvent[] = [agentEnd('lane-0', { taskId: 'task-1', timestamp: '2025-01-15T10:10:00.000Z' })];

    const result = reconstructAgents(events);

    expect(result).toHaveLength(1);
    expect(result[0].agentId).toBe('lane-0');
    expect(result[0].taskId).toBe('task-1');
    expect(result[0].phase).toBe('implementing');
    expect(result[0].profile).toBe('');
    expect(result[0].completedAt).toBe('2025-01-15T10:10:00.000Z');
  });

  it('creates minimal record for agent_end with stepIndex when no matching start event exists', () => {
    const events: AuditEvent[] = [
      agentEnd('lane-0', { taskId: 'task-1', stepIndex: 2, timestamp: '2025-01-15T10:10:00.000Z' }),
    ];

    const result = reconstructAgents(events);

    expect(result).toHaveLength(1);
    expect(result[0].agentId).toBe('lane-0');
    expect(result[0].taskId).toBe('task-1');
    expect(result[0].phase).toBe('implementing');
    expect(result[0].profile).toBe('');
    expect(result[0].completedAt).toBe('2025-01-15T10:10:00.000Z');
  });
});
