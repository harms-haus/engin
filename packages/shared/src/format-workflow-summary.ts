/**
 * Pure workflow-completion summary formatter.
 *
 * Computes a two-line aggregate summary for the TUI event-log pane, shown when
 * a workflow completes:
 *
 *   Line 1 — token usage across ALL agents:
 *     `📊 Tokens: ↑${formatTokenCount(totalInput)} in · ↓${formatTokenCount(totalOutput)} out`
 *
 *   Line 2 — wall-clock total vs. summed agent active time:
 *     `⏱ Time: ${(totalDurationMs/1000).toFixed(1)}s total · ${(agentTimeMs/1000).toFixed(1)}s agent (${agentTimePct}%)`
 *
 * where:
 *   • totalInput / totalOutput  = Σ every agent.inputTokens / .outputTokens
 *   • agentTimeMs               = Σ (Date.parse(completedAt) − Date.parse(startedAt))
 *                                 over agents that have BOTH timestamps
 *   • agentTimePct              = totalDurationMs > 0
 *                                   ? Math.round((agentTimeMs / totalDurationMs) * 100)
 *                                   : 0
 *                                 (CAN exceed 100 — parallel agents)
 *
 * Guard: returns [] when `totalDurationMs` is not a positive number.
 *
 * The function is pure: it neither mutates its inputs nor reads any external
 * state. Token counts are routed through {@link formatTokenCount} for compact
 * human-readable rendering (e.g. 4000 → '4k').
 */

import type { AgentEntity } from './event-types.js';
import { formatTokenCount } from './format-token-count.js';

/**
 * Compute the two-line workflow-completion summary.
 *
 * @param agents          The post-evolve projection's `agents` record.
 * @param totalDurationMs Wall-clock workflow duration in milliseconds.
 * @returns Two formatted lines, or `[]` when `totalDurationMs` is not a
 *          positive number.
 */
export function formatWorkflowSummary(agents: Record<string, AgentEntity>, totalDurationMs: number): string[] {
  // Guard: totalDurationMs must be a positive finite number.
  if (!(typeof totalDurationMs === 'number' && totalDurationMs > 0)) {
    return [];
  }

  // ── Tokens: sum every agent's input/output tokens. ──────────────────────
  let totalInput = 0;
  let totalOutput = 0;

  // ── Agent active time: only agents with BOTH startedAt & completedAt. ───
  let agentTimeMs = 0;

  for (const agent of Object.values(agents)) {
    totalInput += agent.inputTokens;
    totalOutput += agent.outputTokens;

    const startedAt = agent.startedAt;
    const completedAt = agent.completedAt;
    if (startedAt !== undefined && completedAt !== undefined) {
      const start = Date.parse(startedAt);
      const end = Date.parse(completedAt);
      agentTimeMs += end - start;
    }
  }

  const agentTimePct = totalDurationMs > 0 ? Math.round((agentTimeMs / totalDurationMs) * 100) : 0;

  return [
    `📊 Tokens: ↑${formatTokenCount(totalInput)} in · ↓${formatTokenCount(totalOutput)} out`,
    `⏱ Time: ${(totalDurationMs / 1000).toFixed(1)}s total · ${(agentTimeMs / 1000).toFixed(1)}s agent (${agentTimePct}%)`,
  ];
}
