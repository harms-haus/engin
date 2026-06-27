/**
 * Pure workflow-completion summary formatter.
 *
 * Computes a two-line aggregate summary for the TUI event-log pane, shown when
 * a workflow completes:
 *
 *   Line 1 — token usage across ALL sessions:
 *     `📊 Tokens: ↑${formatTokenCount(totalInput)} in · ↓${formatTokenCount(totalOutput)} out`
 *
 *   Line 2 — wall-clock total vs. summed session active time:
 *     `⏱ Time: ${(totalDurationMs/1000).toFixed(1)}s total · ${(sessionTimeMs/1000).toFixed(1)}s session (${sessionTimePct}%)`
 *
 * where:
 *   • totalInput / totalOutput  = Σ every session.inputTokens / .outputTokens
 *   • sessionTimeMs             = Σ (Date.parse(completedAt) − Date.parse(startedAt))
 *                                 over sessions that have BOTH timestamps
 *   • sessionTimePct            = totalDurationMs > 0
 *                                   ? Math.round((sessionTimeMs / totalDurationMs) * 100)
 *                                   : 0
 *                                 (CAN exceed 100 — parallel sessions)
 *
 * Guard: returns [] when `totalDurationMs` is not a positive number.
 *
 * The function is pure: it neither mutates its inputs nor reads any external
 * state. Token counts are routed through {@link formatTokenCount} for compact
 * human-readable rendering (e.g. 4000 → '4k').
 */

import type { SessionEntity } from './event-types.js';
import { formatTokenCount } from './format-token-count.js';

/**
 * Compute the two-line workflow-completion summary.
 *
 * @param sessions        The post-evolve projection's `sessions` record.
 * @param totalDurationMs Wall-clock workflow duration in milliseconds.
 * @returns Two formatted lines, or `[]` when `totalDurationMs` is not a
 *          positive number.
 */
export function formatWorkflowSummary(sessions: Record<string, SessionEntity>, totalDurationMs: number): string[] {
  // Guard: totalDurationMs must be a positive finite number.
  if (!(typeof totalDurationMs === 'number' && totalDurationMs > 0)) {
    return [];
  }

  // ── Tokens: sum every session's input/output tokens. ────────────────────
  let totalInput = 0;
  let totalOutput = 0;

  // ── Session active time: only sessions with BOTH startedAt & completedAt. ─
  let sessionTimeMs = 0;

  for (const session of Object.values(sessions)) {
    totalInput += session.inputTokens;
    totalOutput += session.outputTokens;

    const startedAt = session.startedAt;
    const completedAt = session.completedAt;
    if (startedAt !== undefined && completedAt !== undefined) {
      const start = Date.parse(startedAt);
      const end = Date.parse(completedAt);
      sessionTimeMs += end - start;
    }
  }

  const sessionTimePct = totalDurationMs > 0 ? Math.round((sessionTimeMs / totalDurationMs) * 100) : 0;

  return [
    `📊 Tokens: ↑${formatTokenCount(totalInput)} in · ↓${formatTokenCount(totalOutput)} out`,
    `⏱ Time: ${(totalDurationMs / 1000).toFixed(1)}s total · ${(sessionTimeMs / 1000).toFixed(1)}s session (${sessionTimePct}%)`,
  ];
}
