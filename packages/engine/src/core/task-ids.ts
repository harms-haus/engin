// ─── assignSequentialTaskIds ─────────────────────────────────────────────────
// Renumbers arbitrary task IDs to a zero-padded t-01, t-02 … format and
// remaps all dependency references accordingly.

/**
 * Build a sequential id-map then renumber every task and its dependencies.
 *
 * New IDs follow the pattern `t-01`, `t-02`, … `t-10`, `t-11`, … based on
 * the index of each task in the input array (1-based).
 *
 * @param tasks – The original task list. NOT mutated.
 * @returns A new task list with sequential IDs and remapped dependencies.
 */
export function assignSequentialTaskIds<T extends { id: string; dependencies: string[] }>(tasks: T[]): T[] {
  // 1. Build mapping from original IDs to sequential IDs
  const idMap = new Map<string, string>();
  tasks.forEach((task, i) => {
    idMap.set(task.id, 't-' + String(i + 1).padStart(2, '0'));
  });

  // 2. Map over tasks – new objects with remapped ids and dependencies
  return tasks.map((task) => ({
    ...task,
    id: idMap.get(task.id) ?? task.id,
    dependencies: task.dependencies.map((depId) => idMap.get(depId) ?? depId),
  })) as T[];
}
