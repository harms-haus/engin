// ─── formatWorkflowSummary tests — @engin/shared/format-workflow-summary ────
//
// `formatWorkflowSummary(agents, totalDurationMs)` computes a two-line
// workflow-completion summary for the TUI event-log pane:
//
//   Line 1 — aggregate token usage across ALL agents:
//     `📊 Tokens: ↑${formatTokenCount(totalInput)} in · ↓${formatTokenCount(totalOutput)} out`
//
//   Line 2 — wall-clock total vs. summed agent active time:
//     `⏱ Time: ${(totalDurationMs/1000).toFixed(1)}s total · ${(agentTimeMs/1000).toFixed(1)}s agent (${agentTimePct}%)`
//
// where:
//   • totalInput / totalOutput  = Σ every agent.inputTokens / .outputTokens
//   • agentTimeMs               = Σ (Date.parse(completedAt) − Date.parse(startedAt))
//                                 over agents that have BOTH timestamps
//   • agentTimePct              = totalDurationMs > 0
//                                   ? Math.round((agentTimeMs / totalDurationMs) * 100)
//                                   : 0
//                                 (CAN exceed 100 — parallel agents)
//
// Guard: returns [] when `totalDurationMs` is not a positive number.
//
// The canonical home of the function is @engin/shared/format-workflow-summary;
// it is also re-exported from the package barrel (@engin/shared), verified at
// the bottom of this file. `formatTokenCount` is imported from
// @engin/shared/format-token-count.

import { describe, expect, it } from 'bun:test';

// ── Canonical home (subpath import) ─────────────────────────────────────────
import type { AgentEntity } from '@engin/shared/event-types';
import { formatWorkflowSummary } from '@engin/shared/format-workflow-summary';

// ── Cross-check dependencies ────────────────────────────────────────────────
import { formatTokenCount } from '@engin/shared/format-token-count';

// ── Barrel import (verified to resolve to the same function) ────────────────
import { formatWorkflowSummary as formatWorkflowSummaryFromBarrel } from '@engin/shared';

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Fixed epoch; `ts(seconds)` returns an ISO string exactly `seconds` later. */
const T0 = '2026-06-15T00:00:00.000Z';
function ts(seconds: number): string {
  return new Date(Date.parse(T0) + seconds * 1000).toISOString();
}

/** Build a minimal AgentEntity, overriding only the fields under test. */
function makeAgent(overrides: Partial<AgentEntity> = {}): AgentEntity {
  return {
    uid: 'a',
    agentId: 'a',
    profile: 'coder',
    phaseId: 'p',
    active: false,
    log: [],
    toolCallCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    taskTitle: '',
    ...overrides,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Contract: two-agent example called out by the task spec
// (agent A spans 30s, agent B spans 45s, totalDurationMs 60000 → 125%)
// ────────────────────────────────────────────────────────────────────────────

describe('formatWorkflowSummary — task-spec two-agent example (parallel → 125%)', () => {
  const agents: Record<string, AgentEntity> = {
    'a1::t1': makeAgent({
      uid: 'a1::t1',
      agentId: 'a1',
      inputTokens: 1500,
      outputTokens: 500,
      startedAt: T0,
      completedAt: ts(30), // 30s active
    }),
    'a2::t2': makeAgent({
      uid: 'a2::t2',
      agentId: 'a2',
      inputTokens: 2500,
      outputTokens: 1000,
      startedAt: T0,
      completedAt: ts(45), // 45s active
    }),
  };

  const lines = formatWorkflowSummary(agents, 60000);

  it('returns exactly two lines', () => {
    expect(lines).toHaveLength(2);
  });

  it('line 1 sums input/output tokens across both agents', () => {
    // 1500 + 2500 = 4000 → '4k'; 500 + 1000 = 1500 → '1.5k'
    expect(lines[0]).toBe('📊 Tokens: ↑4k in · ↓1.5k out');
  });

  it('line 2 reports total vs. summed agent time with pct exceeding 100', () => {
    // agentTimeMs = 30000 + 45000 = 75000 → 75.0s; pct = round(75000/60000*100) = 125
    expect(lines[1]).toBe('⏱ Time: 60.0s total · 75.0s agent (125%)');
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Guard: totalDurationMs must be a positive number, else []
// ────────────────────────────────────────────────────────────────────────────

describe('formatWorkflowSummary — returns [] when totalDurationMs is not a positive number', () => {
  const agents: Record<string, AgentEntity> = {
    a1: makeAgent({ inputTokens: 100, outputTokens: 50, startedAt: T0, completedAt: ts(10) }),
  };

  it('returns [] for zero', () => {
    expect(formatWorkflowSummary(agents, 0)).toEqual([]);
  });

  it('returns [] for a negative duration', () => {
    expect(formatWorkflowSummary(agents, -1000)).toEqual([]);
  });

  it('returns [] for NaN', () => {
    expect(formatWorkflowSummary(agents, Number.NaN)).toEqual([]);
  });

  it('returns [] even when agents carry tokens/time (guard short-circuits before computing)', () => {
    expect(formatWorkflowSummary(agents, 0)).toEqual([]);
    expect(formatWorkflowSummary(agents, -1)).toEqual([]);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Token summation across all agents (uses formatTokenCount)
// ────────────────────────────────────────────────────────────────────────────

describe('formatWorkflowSummary — token aggregation', () => {
  it('sums inputTokens and outputTokens across every agent', () => {
    const agents: Record<string, AgentEntity> = {
      a1: makeAgent({ inputTokens: 100, outputTokens: 40, startedAt: T0, completedAt: ts(5) }),
      a2: makeAgent({ inputTokens: 200, outputTokens: 60, startedAt: T0, completedAt: ts(5) }),
      a3: makeAgent({ inputTokens: 300, outputTokens: 100, startedAt: T0, completedAt: ts(5) }),
    };
    // 600 in / 200 out — both below 1000, render as plain integers.
    const [tokenLine] = formatWorkflowSummary(agents, 10000);
    expect(tokenLine).toBe('📊 Tokens: ↑600 in · ↓200 out');
  });

  it('routes the totals through formatTokenCount (k / m thresholds)', () => {
    const agents: Record<string, AgentEntity> = {
      a1: makeAgent({ inputTokens: 1_000_000, outputTokens: 250_000, startedAt: T0, completedAt: ts(5) }),
      a2: makeAgent({ inputTokens: 500_000, outputTokens: 250_000, startedAt: T0, completedAt: ts(5) }),
    };
    // 1_500_000 in → '1.5m'; 500_000 out → '500k'
    const [tokenLine] = formatWorkflowSummary(agents, 10000);
    expect(tokenLine).toBe('📊 Tokens: ↑1.5m in · ↓500k out');
    // Cross-check the embedded values against formatTokenCount directly.
    expect(tokenLine).toBe(`📊 Tokens: ↑${formatTokenCount(1_500_000)} in · ↓${formatTokenCount(500_000)} out`);
  });

  it('counts tokens from agents that lack startedAt/completedAt (token sum is independent of time)', () => {
    const agents: Record<string, AgentEntity> = {
      // No timestamps at all — still contributes its tokens.
      a1: makeAgent({ inputTokens: 1200, outputTokens: 300 }),
    };
    const [tokenLine] = formatWorkflowSummary(agents, 10000);
    expect(tokenLine).toBe('📊 Tokens: ↑1.2k in · ↓300 out');
  });

  it('renders zero tokens as "0" when no agent has any', () => {
    const agents: Record<string, AgentEntity> = {
      a1: makeAgent({ startedAt: T0, completedAt: ts(5) }),
    };
    const [tokenLine] = formatWorkflowSummary(agents, 10000);
    expect(tokenLine).toBe('📊 Tokens: ↑0 in · ↓0 out');
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Agent active-time summation (only agents with BOTH startedAt & completedAt)
// ────────────────────────────────────────────────────────────────────────────

describe('formatWorkflowSummary — agent active-time aggregation', () => {
  it('sums Date.parse(completedAt) − Date.parse(startedAt) across eligible agents', () => {
    const agents: Record<string, AgentEntity> = {
      a1: makeAgent({ startedAt: T0, completedAt: ts(10) }), // 10s
      a2: makeAgent({ startedAt: T0, completedAt: ts(25) }), // 25s
      a3: makeAgent({ startedAt: T0, completedAt: ts(15) }), // 15s
    };
    // agentTimeMs = 50000; totalDurationMs = 50000 → 50.0s / 50.0s / 100%
    const [, timeLine] = formatWorkflowSummary(agents, 50000);
    expect(timeLine).toBe('⏱ Time: 50.0s total · 50.0s agent (100%)');
  });

  it('skips agents missing completedAt (startedAt only)', () => {
    const agents: Record<string, AgentEntity> = {
      a1: makeAgent({ startedAt: T0 }), // no completedAt → skip
      a2: makeAgent({ startedAt: T0, completedAt: ts(20) }), // 20s
    };
    const [, timeLine] = formatWorkflowSummary(agents, 40000);
    expect(timeLine).toBe('⏱ Time: 40.0s total · 20.0s agent (50%)');
  });

  it('skips agents missing startedAt (completedAt only)', () => {
    const agents: Record<string, AgentEntity> = {
      a1: makeAgent({ completedAt: ts(20) }), // no startedAt → skip
      a2: makeAgent({ startedAt: T0, completedAt: ts(20) }), // 20s
    };
    const [, timeLine] = formatWorkflowSummary(agents, 40000);
    expect(timeLine).toBe('⏱ Time: 40.0s total · 20.0s agent (50%)');
  });

  it('skips agents missing both timestamps', () => {
    const agents: Record<string, AgentEntity> = {
      a1: makeAgent({}), // neither → skip
      a2: makeAgent({ startedAt: T0, completedAt: ts(20) }), // 20s
    };
    const [, timeLine] = formatWorkflowSummary(agents, 40000);
    expect(timeLine).toBe('⏱ Time: 40.0s total · 20.0s agent (50%)');
  });
});

// ────────────────────────────────────────────────────────────────────────────
// agentTimePct behaviour
// ────────────────────────────────────────────────────────────────────────────

describe('formatWorkflowSummary — agentTimePct', () => {
  it('can exceed 100 when agents run in parallel', () => {
    const agents: Record<string, AgentEntity> = {
      a1: makeAgent({ startedAt: T0, completedAt: ts(30) }),
      a2: makeAgent({ startedAt: T0, completedAt: ts(45) }),
    };
    const [, timeLine] = formatWorkflowSummary(agents, 60000);
    expect(timeLine).toBe('⏱ Time: 60.0s total · 75.0s agent (125%)');
  });

  it('rounds to the nearest whole percent (Math.round)', () => {
    // agentTimeMs = 10000, totalDurationMs = 30000 → 33.33…% → 33
    const agents: Record<string, AgentEntity> = {
      a1: makeAgent({ startedAt: T0, completedAt: ts(10) }),
    };
    const [, timeLine] = formatWorkflowSummary(agents, 30000);
    expect(timeLine).toBe('⏱ Time: 30.0s total · 10.0s agent (33%)');
  });

  it('is 0 when no agent has both timestamps (but totalDurationMs > 0)', () => {
    const agents: Record<string, AgentEntity> = {
      a1: makeAgent({ startedAt: T0 }), // no completedAt
      a2: makeAgent({ completedAt: ts(10) }), // no startedAt
    };
    const [, timeLine] = formatWorkflowSummary(agents, 10000);
    expect(timeLine).toBe('⏱ Time: 10.0s total · 0.0s agent (0%)');
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Edge cases: empty agents and single agent
// ────────────────────────────────────────────────────────────────────────────

describe('formatWorkflowSummary — edge cases', () => {
  it('handles an empty agents record (0 tokens, 0 agent time)', () => {
    const lines = formatWorkflowSummary({}, 10000);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe('📊 Tokens: ↑0 in · ↓0 out');
    expect(lines[1]).toBe('⏱ Time: 10.0s total · 0.0s agent (0%)');
  });

  it('handles a single fully-populated agent (100%)', () => {
    const agents: Record<string, AgentEntity> = {
      a1: makeAgent({ inputTokens: 500, outputTokens: 250, startedAt: T0, completedAt: ts(10) }),
    };
    const lines = formatWorkflowSummary(agents, 10000);
    expect(lines).toEqual(['📊 Tokens: ↑500 in · ↓250 out', '⏱ Time: 10.0s total · 10.0s agent (100%)']);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Pure function sanity
// ────────────────────────────────────────────────────────────────────────────

describe('formatWorkflowSummary — pure function sanity', () => {
  it('always returns a string array', () => {
    const agents: Record<string, AgentEntity> = {
      a1: makeAgent({ startedAt: T0, completedAt: ts(5) }),
    };
    const lines = formatWorkflowSummary(agents, 10000);
    expect(Array.isArray(lines)).toBe(true);
    expect(lines.every((l: string) => typeof l === 'string')).toBe(true);
  });

  it('does not mutate the input agents record or its entities', () => {
    const agents: Record<string, AgentEntity> = {
      a1: makeAgent({ inputTokens: 1234, outputTokens: 567, startedAt: T0, completedAt: ts(7) }),
    };
    const snapshot = JSON.parse(JSON.stringify(agents));

    formatWorkflowSummary(agents, 10000);
    formatWorkflowSummary(agents, 10000);

    expect(JSON.parse(JSON.stringify(agents))).toEqual(snapshot);
  });

  it('is deterministic: identical inputs yield identical outputs', () => {
    const agents: Record<string, AgentEntity> = {
      a1: makeAgent({ inputTokens: 1234, outputTokens: 567, startedAt: T0, completedAt: ts(7) }),
    };
    expect(formatWorkflowSummary(agents, 10000)).toEqual(formatWorkflowSummary(agents, 10000));
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Barrel re-export — `import { formatWorkflowSummary } from '@engin/shared'`
// resolves to the same function as the canonical subpath.
// ────────────────────────────────────────────────────────────────────────────

describe('@engin/shared barrel — re-exports formatWorkflowSummary', () => {
  it('resolves formatWorkflowSummary from the package barrel', () => {
    expect(typeof formatWorkflowSummaryFromBarrel).toBe('function');
  });

  it('the barrel export is the SAME function as the subpath export', () => {
    expect(formatWorkflowSummaryFromBarrel).toBe(formatWorkflowSummary);
  });

  it('the barrel export produces identical output to the subpath export', () => {
    const agents: Record<string, AgentEntity> = {
      a1: makeAgent({ inputTokens: 1500, outputTokens: 500, startedAt: T0, completedAt: ts(30) }),
      a2: makeAgent({ inputTokens: 2500, outputTokens: 1000, startedAt: T0, completedAt: ts(45) }),
    };
    expect(formatWorkflowSummaryFromBarrel(agents, 60000)).toEqual(formatWorkflowSummary(agents, 60000));
  });
});
