import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { WorkflowState } from '../core/types.js';
import { isEnoentError } from '../core/utils.js';
import type { WorkflowStatusTracker } from './workflow-status.js';

/**
 * Serialize a WorkflowStatusTracker's state into a plain WorkflowState object.
 */
export function serializeWorkflowState(tracker: WorkflowStatusTracker): WorkflowState {
  return {
    taskPrompt: tracker.taskPrompt,
    currentPhase: tracker.currentPhase,
    completedPhases: tracker.completedPhases,
    tasks: tracker.taskTracker.getAllTasks(),
    scoutingReports: tracker.scoutingReports,
    plan: tracker.plan,
    research: tracker.research,
    planReviewFeedback: tracker.planReviewFeedback,
    planReviewSuggestions: tracker.planReviewSuggestions,
    stats: { ...tracker.stats },
    spawnedAgents: tracker.spawnedAgents.length > 0 ? tracker.spawnedAgents.map((a) => ({ ...a })) : [],
    sidebar: tracker.sidebar,
    worktree: tracker.worktree,
  };
}

/**
 * Atomically write the tracker state to disk.
 * Writes to a temporary file then renames to the final path.
 */
export async function saveWorkflowState(tracker: WorkflowStatusTracker, workDir: string): Promise<void> {
  await mkdir(workDir, { recursive: true });
  const filePath = join(workDir, '.engin-state.json');
  const tmpPath = join(workDir, '.engin-state.json.tmp');
  await writeFile(tmpPath, JSON.stringify(serializeWorkflowState(tracker), null, 2), 'utf-8');
  await rename(tmpPath, filePath);
}

/**
 * Read and parse the workflow state file from disk.
 * Throws if the file does not exist or cannot be parsed.
 */
export async function loadWorkflowState(workDir: string): Promise<WorkflowState> {
  const filePath = join(workDir, '.engin-state.json');
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf-8');
  } catch (err: unknown) {
    if (isEnoentError(err)) {
      throw new Error(`Workflow state file not found at "${filePath}"`, { cause: err });
    }
    throw new Error('Failed to load workflow state', { cause: err });
  }
  return JSON.parse(raw) as WorkflowState;
}
