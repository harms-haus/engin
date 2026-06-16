/**
 * Generate a composite key for an agent, optionally scoped to a task.
 */
export function agentKey(agentId: string, taskId?: string): string {
  return taskId ? agentId + '::' + taskId : agentId;
}
