// ─── Composite key helper ──────────────────────────────────────────────────

/**
 * Build a composite Map key from an agentId and optional taskId.
 *
 * When taskId is present the key is `agentId::taskId` so that agents with
 * the same agentId but different tasks are stored as separate entries.
 */
export function agentKey(agentId: string, taskId?: string): string {
  return taskId ? `${agentId}::${taskId}` : agentId;
}
